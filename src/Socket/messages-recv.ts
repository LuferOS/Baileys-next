import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import Long from 'long'
import { proto } from '../../WAProto/index.js'
import {
	DEFAULT_CACHE_TTLS,
	KEY_BUNDLE_TYPE,
	MIN_PREKEY_COUNT,
	PLACEHOLDER_MAX_AGE_SECONDS,
	STATUS_EXPIRY_SECONDS
} from '../Defaults'
import type {
	GroupParticipant,
	MessageReceiptType,
	MessageRelayOptions,
	MessageUserReceipt,
	NewChatMessageCapInfo,
	SocketConfig,
	WACallEvent,
	WAMessage,
	WAMessageKey,
	WAPatchName
} from '../Types'
import { ReachoutTimelockEnforcementType, WAMessageStatus, WAMessageStubType } from '../Types'
import { NodeCacheAdapter } from '../Utils'
import {
	ACCOUNT_RESTRICTED_TEXT,
	aesDecryptCTR,
	aesEncryptGCM,
	cleanMessage,
	Curve,
	decodeMediaRetryNode,
	decodeMessageNode,
	decryptMessageNode,
	delay,
	derivePairingCodeKey,
	encodeBigEndian,
	encodeSignedDeviceIdentity,
	extractAddressingContext,
	extractE2ESessionFromRetryReceipt,
	getCallStatusFromNode,
	getHistoryMsg,
	getNextPreKeys,
	getStatusFromReceiptType,
	handleIdentityChange,
	hkdf,
	MISSING_KEYS_ERROR_TEXT,
	NACK_REASONS,
	NO_MESSAGE_FOUND_ERROR_TEXT,
	SERVER_ERROR_CODES,
	toNumber,
	unixTimestampSeconds,
	xmppPreKey,
	xmppSignedPreKey
} from '../Utils'
import { makeMutex } from '../Utils/make-mutex'
import { makeOfflineNodeProcessor, type MessageType } from '../Utils/offline-node-processor'
import { buildAckStanza } from '../Utils/stanza-ack'
import {
	buildMergedTcTokenIndexWrite,
	isTcTokenExpired,
	readTcTokenIndex,
	resolveIssuanceJid,
	resolveTcTokenJid,
	storeTcTokenFromMessage,
	storeTcTokensFromIqResult,
	TC_TOKEN_INDEX_KEY
} from '../Utils/tc-token-utils'
import {
	areJidsSameUser,
	type BinaryNode,
	binaryNodeToString,
	getAllBinaryNodeChildren,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	getBinaryNodeChildUInt,
	isJidGroup,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	jidDecode,
	jidNormalizedUser,
	type JidWithDevice,
	S_WHATSAPP_NET
} from '../WABinary'
import { extractGroupMetadata } from './groups'
import { makeMessagesSocket } from './messages-send'

type MexGqlData = Record<string, unknown>

type MexGqlResponse = {
	data?: MexGqlData
	errors?: unknown[]
}

type ReachoutTimelockNotificationPayload = {
	is_active?: boolean
	enforcement_type?: string
	time_enforcement_ends?: string
}

const ENFORCEMENT_TYPE_VALUES = new Set<string>(Object.values(ReachoutTimelockEnforcementType))

function isValidEnforcementType(value: string | undefined): value is ReachoutTimelockEnforcementType {
	return typeof value === 'string' && ENFORCEMENT_TYPE_VALUES.has(value)
}

export class MessagesRecvHandler {
	public getLIDForPN: any
	public retryMutex = makeMutex()
	public msgRetryCache: NodeCacheAdapter<number> | any
	public callOfferCache: NodeCacheAdapter<WACallEvent> | any
	public identityAssertDebounce: any
	public sendActiveReceipts = false
	public lastTcTokenPruneTs = 0
	public inFlight463Recoveries = new Set<string>()
	public tcTokenKnownJids = new Set<string>()
	public inFlightPreKeyLow = new Set<string>()
	public tcTokenIndexTimer?: NodeJS.Timeout
	public tcTokenIndexLoaded: Promise<void>
	public offlineNodeProcessor: ReturnType<typeof makeOfflineNodeProcessor>

	constructor(
		public sock: ReturnType<typeof makeMessagesSocket>,
		public config: SocketConfig
	) {
		this.getLIDForPN = this.sock.signalRepository.lidMapping.getLIDForPN.bind(this.sock.signalRepository.lidMapping)

		this.msgRetryCache =
			this.config.msgRetryCounterCache ||
			new NodeCacheAdapter<number>({
				max: this.config.lowMemMode ? 50 : 500,
				ttl: DEFAULT_CACHE_TTLS.MSG_RETRY * 1000 // 1 hour in ms
			})
		this.callOfferCache =
			this.config.callOfferCache ||
			new NodeCacheAdapter<WACallEvent>({
				max: this.config.lowMemMode ? 10 : 50,
				ttl: DEFAULT_CACHE_TTLS.CALL_OFFER * 1000 // 5 mins in ms
			})

		// Debounce identity-change session refreshes per JID to avoid bursts
		this.identityAssertDebounce = new NodeCacheAdapter<boolean>({
			max: this.config.lowMemMode ? 50 : 500,
			ttl: 5000
		})

		this.offlineNodeProcessor = makeOfflineNodeProcessor(
			new Map<MessageType, (node: BinaryNode) => Promise<void>>([
				['message', this.handleMessage.bind(this)],
				['call', this.handleCall.bind(this)],
				['receipt', this.handleReceipt.bind(this)],
				['notification', this.handleNotification.bind(this)]
			]),
			{
				isWsOpen: () => this.sock.ws.isOpen,
				onUnexpectedError: this.sock.onUnexpectedError,
				yieldToEventLoop: () => new Promise(resolve => setImmediate(resolve))
			}
		)

		this.tcTokenIndexLoaded = (async () => {
			const persisted = await readTcTokenIndex(this.sock.authState.keys)
			for (const jid of persisted) this.tcTokenKnownJids.add(jid)
			this.config.logger.debug({ count: this.tcTokenKnownJids.size }, 'loaded tctoken index')
		})()
	}

	public fetchMessageHistory = async (
		count: number,
		oldestMsgKey: WAMessageKey,
		oldestMsgTimestamp: number | Long
	): Promise<string> => {
		if (!this.sock.authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const pdoMessage: proto.Message.IPeerDataOperationRequestMessage = {
			historySyncOnDemandRequest: {
				chatJid: oldestMsgKey.remoteJid,
				oldestMsgFromMe: oldestMsgKey.fromMe,
				oldestMsgId: oldestMsgKey.id,
				oldestMsgTimestampMs: oldestMsgTimestamp,
				onDemandMsgCount: count
			},
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
		}

		return this.sock.sendPeerDataOperationMessage(pdoMessage)
	}

	public requestPlaceholderResend = async (
		messageKey: WAMessageKey,
		msgData?: Partial<WAMessage>
	): Promise<string | undefined> => {
		if (!this.sock.authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		if (await this.sock.placeholderResendCache.get(messageKey?.id!)) {
			this.config.logger.debug({ messageKey }, 'already requested resend')
			return
		} else {
			// Store original message data so PDO response handler can preserve
			// metadata (LID details, timestamps, etc.) that the phone may omit
			await this.sock.placeholderResendCache.set(messageKey?.id!, msgData || true)
		}

		await delay(2000)

		if (!(await this.sock.placeholderResendCache.get(messageKey?.id!))) {
			this.config.logger.debug({ messageKey }, 'message received while resend requested')
			return 'RESOLVED'
		}

		const pdoMessage = {
			placeholderMessageResendRequest: [
				{
					messageKey
				}
			],
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
		}

		setTimeout(async () => {
			if (await this.sock.placeholderResendCache.get(messageKey?.id!)) {
				this.config.logger.debug({ messageKey }, 'PDO message without response after 8 seconds. Phone possibly offline')
				await this.sock.placeholderResendCache.del(messageKey?.id!)
			}
		}, 8_000)

		return this.sock.sendPeerDataOperationMessage(pdoMessage)
	}

	public handleMexNotification = async (node: BinaryNode) => {
		const updateNode = getBinaryNodeChild(node, 'update')

		if (updateNode) {
			const opName = updateNode.attrs?.op_name
			if (!opName) {
				this.config.logger.warn(
					{ node: binaryNodeToString(node) },
					'mex notification missing op_name, fallback to legacy'
				)
				await this.handleLegacyMexNewsletterNotification(node)
				return
			}

			let mexResponse: MexGqlResponse
			try {
				mexResponse = JSON.parse(updateNode.content!.toString())
			} catch (error) {
				this.config.logger.error({ err: error, opName }, 'failed to parse mex notification JSON')
				return
			}

			if (mexResponse.errors?.length) {
				this.config.logger.warn({ errors: mexResponse.errors, opName }, 'mex notification has GQL errors')
				return
			}

			const data = mexResponse.data
			if (!data) {
				this.config.logger.warn({ opName }, 'mex notification has null data')
				return
			}

			this.config.logger.debug({ opName }, 'processing mex notification')

			switch (opName) {
				case 'NotificationUserReachoutTimelockUpdate':
					this.handleReachoutTimelockNotification(data)
					break

				case 'MessageCappingInfoNotification':
					this.handleMessageCappingNotification(data)
					break

				// newsletter ops still use the legacy <mex> child structure
				case 'NotificationNewsletterUpdate':
				case 'NotificationLinkedProfilesUpdates':
				case 'NotificationNewsletterAdminPromote':
				case 'NotificationNewsletterAdminDemote':
				case 'NotificationNewsletterUserSettingChange':
				case 'NotificationNewsletterJoin':
				case 'NotificationNewsletterLeave':
				case 'NotificationNewsletterStateChange':
				case 'NotificationNewsletterAdminMetadataUpdate':
				case 'NotificationNewsletterOwnerUpdate':
				case 'NotificationNewsletterAdminInviteRevoke':
				case 'NotificationNewsletterWamoSubStatusChange':
				case 'NotificationNewsletterBlockUser':
				case 'NotificationNewsletterPaidPartnership':
				case 'NotificationNewsletterMilestone':
				case 'NewsletterResponseStateUpdate':
					await this.handleLegacyMexNewsletterNotification(node)
					break

				default:
					this.config.logger.debug({ opName }, 'unhandled mex notification')
					break
			}

			return
		}

		await this.handleLegacyMexNewsletterNotification(node)
	}

	public handleReachoutTimelockNotification = (data: MexGqlData) => {
		const payload = data.xwa2_notify_account_reachout_timelock as ReachoutTimelockNotificationPayload | undefined

		if (!payload) {
			this.config.logger.warn('reachout timelock notification missing payload')
			return
		}

		if (!payload.is_active) {
			this.config.logger.info('reachout timelock restriction lifted')
			this.sock.ev.emit('connection.update', {
				reachoutTimeLock: {
					isActive: false,
					enforcementType: ReachoutTimelockEnforcementType.DEFAULT
				}
			})
			return
		}

		// WA Web defaults to now+60s when the server omits the expiry
		const timeEnforcementEnds = payload.time_enforcement_ends
			? new Date(parseInt(payload.time_enforcement_ends, 10) * 1000)
			: new Date(Date.now() + 60_000)

		const enforcementType = isValidEnforcementType(payload.enforcement_type)
			? payload.enforcement_type
			: ReachoutTimelockEnforcementType.DEFAULT

		this.config.logger.info({ enforcementType, timeEnforcementEnds }, 'reachout timelock restriction set')

		this.sock.ev.emit('connection.update', {
			reachoutTimeLock: {
				isActive: true,
				timeEnforcementEnds,
				enforcementType
			}
		})
	}

	public handleMessageCappingNotification = (data: MexGqlData) => {
		const payload = data.xwa2_notify_new_chat_messages_capping_info_update as NewChatMessageCapInfo | undefined

		if (!payload) {
			this.config.logger.warn('message capping notification missing payload')
			return
		}

		this.config.logger.info({ payload }, 'received message capping update')
		this.sock.ev.emit('message-capping.update', payload)
	}

	public handleLegacyMexNewsletterNotification = async (node: BinaryNode) => {
		const mexNode = getBinaryNodeChild(node, 'mex')
		const updateNode = mexNode?.content ? null : getBinaryNodeChild(node, 'update') || getAllBinaryNodeChildren(node)[0]
		const payloadNode = mexNode?.content ? mexNode : updateNode
		if (!payloadNode?.content) {
			this.config.logger.warn({ node: binaryNodeToString(node) }, 'invalid mex newsletter notification')
			return
		}

		let data: any
		try {
			const payloadContent = payloadNode.content
			if (Array.isArray(payloadContent)) {
				this.config.logger.warn({ payloadNode }, 'invalid mex newsletter notification payload format')
				return
			}

			const contentBuf =
				typeof payloadContent === 'string' ? Buffer.from(payloadContent, 'binary') : Buffer.from(payloadContent)
			data = JSON.parse(contentBuf.toString())
		} catch (error) {
			this.config.logger.error(
				{ err: error, node: binaryNodeToString(node) },
				'failed to parse mex newsletter notification'
			)
			return
		}

		const operation = data?.operation ?? payloadNode?.attrs?.op_name
		let updates = data?.updates
		if (!updates) {
			const linkedProfiles = data?.data?.xwa2_notify_linked_profiles
			if (linkedProfiles) {
				updates = [linkedProfiles]
			}
		}

		if (!updates || !operation) {
			this.config.logger.warn({ data }, 'invalid mex newsletter notification content')
			return
		}

		this.config.logger.info({ operation, updates }, 'got mex newsletter notification')

		switch (operation) {
			case 'NotificationNewsletterUpdate':
				for (const update of updates) {
					if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
						this.sock.ev.emit('newsletter-settings.update', {
							id: update.jid,
							update: update.settings
						})
					}
				}

				break

			case 'NotificationNewsletterAdminPromote':
				for (const update of updates) {
					if (update.jid && update.user) {
						this.sock.ev.emit('newsletter-participants.update', {
							id: update.jid,
							author: node.attrs.from!,
							user: update.user,
							new_role: 'ADMIN',
							action: 'promote'
						})
					}
				}

				break

			case 'NotificationLinkedProfilesUpdates':
				for (const update of updates) {
					const lid = update?.jid
					const addedProfiles = Array.isArray(update?.added_profiles) ? update.added_profiles : []
					const mappings = []
					for (const profile of addedProfiles) {
						const pn = typeof profile === 'string' ? profile : (profile?.pn ?? profile?.jid ?? null)
						if (lid && pn) {
							const mapping = { lid, pn }
							this.sock.ev.emit('lid-mapping.update', mapping)
							mappings.push(mapping)
						}
					}

					await this.sock.signalRepository.lidMapping.storeLIDPNMappings(mappings)
				}

				break

			default:
				this.config.logger.info({ operation, data }, 'unhandled mex newsletter notification')
				break
		}
	}

	// Handles newsletter notifications
	public handleNewsletterNotification = async (node: BinaryNode) => {
		const from = node.attrs.from!
		const children = getAllBinaryNodeChildren(node)
		const author = node.attrs.participant!

		for (const child of children) {
			this.config.logger.debug({ from, child }, 'got newsletter notification')

			switch (child.tag) {
				case 'reaction': {
					const reactionUpdate = {
						id: from,
						server_id: child.attrs.message_id!,
						reaction: {
							code: getBinaryNodeChildString(child, 'reaction'),
							count: 1
						}
					}
					this.sock.ev.emit('newsletter.reaction', reactionUpdate)
					break
				}

				case 'view': {
					const viewUpdate = {
						id: from,
						server_id: child.attrs.message_id!,
						count: parseInt(child.content?.toString() || '0', 10)
					}
					this.sock.ev.emit('newsletter.view', viewUpdate)
					break
				}

				case 'participant': {
					const participantUpdate = {
						id: from,
						author,
						user: child.attrs.jid!,
						action: child.attrs.action!,
						new_role: child.attrs.role!
					}
					this.sock.ev.emit('newsletter-participants.update', participantUpdate)
					break
				}

				case 'update': {
					const settingsNode = getBinaryNodeChild(child, 'settings')
					if (settingsNode) {
						const update: Record<string, any> = {}
						const nameNode = getBinaryNodeChild(settingsNode, 'name')
						if (nameNode?.content) update.name = nameNode.content.toString()

						const descriptionNode = getBinaryNodeChild(settingsNode, 'description')
						if (descriptionNode?.content) update.description = descriptionNode.content.toString()

						this.sock.ev.emit('newsletter-settings.update', {
							id: from,
							update
						})
					}

					break
				}

				case 'message': {
					const plaintextNode = getBinaryNodeChild(child, 'plaintext')
					if (plaintextNode?.content) {
						try {
							const contentBuf =
								typeof plaintextNode.content === 'string'
									? Buffer.from(plaintextNode.content, 'binary')
									: Buffer.from(plaintextNode.content as Uint8Array)
							const messageProto = proto.Message.decode(contentBuf).toJSON()
							const fullMessage = proto.WebMessageInfo.fromObject({
								key: {
									remoteJid: from,
									id: child.attrs.message_id || child.attrs.server_id,
									fromMe: false // TODO: is this really true though
								},
								message: messageProto,
								messageTimestamp: +child.attrs.t!
							}).toJSON() as WAMessage
							await this.sock.upsertMessage(fullMessage, 'append')
							this.config.logger.debug('Processed plaintext newsletter message')
						} catch (error) {
							this.config.logger.error({ error }, 'Failed to decode plaintext newsletter message')
						}
					}

					break
				}

				default:
					this.config.logger.warn({ node, child }, 'Unknown newsletter notification child')
					break
			}
		}
	}

	public sendMessageAck = async (node: BinaryNode, errorCode?: number) => {
		const stanza = buildAckStanza(node, errorCode, this.sock.authState.creds.me!.id)
		this.config.logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack')
		await this.sock.sendNode(stanza)
	}

	public rejectCall = async (callId: string, callFrom: string) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				from: this.sock.authState.creds.me!.id,
				to: callFrom
			},
			content: [
				{
					tag: 'reject',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						count: '0'
					},
					content: undefined
				}
			]
		}
		await this.sock.query(stanza)
	}

	public sendRetryRequest = async (node: BinaryNode, forceIncludeKeys = false) => {
		const { fullMessage } = decodeMessageNode(
			node,
			this.sock.authState.creds.me!.id,
			this.sock.authState.creds.me!.lid || ''
		)
		const { key: msgKey } = fullMessage
		const msgId = msgKey.id!

		if (this.sock.messageRetryManager) {
			// Check if we've exceeded max retries using the new system
			if (this.sock.messageRetryManager.hasExceededMaxRetries(msgId)) {
				this.config.logger.debug({ msgId }, 'reached retry limit with new retry manager, clearing')
				this.sock.messageRetryManager.markRetryFailed(msgId)
				return
			}

			// Increment retry count using new system
			const retryCount = this.sock.messageRetryManager.incrementRetryCount(msgId)

			// Use the new retry count for the rest of the logic
			const key = `${msgId}:${msgKey?.participant}`
			await this.msgRetryCache.set(key, retryCount)
		} else {
			// Fallback to old system
			const key = `${msgId}:${msgKey?.participant}`
			let retryCount = (await this.msgRetryCache.get(key)) || 0
			if (retryCount >= this.config.maxMsgRetryCount) {
				this.config.logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')
				await this.msgRetryCache.del(key)
				return
			}

			retryCount += 1
			await this.msgRetryCache.set(key, retryCount)
		}

		const key = `${msgId}:${msgKey?.participant}`
		const retryCount = (await this.msgRetryCache.get(key)) || 1

		const { account, signedPreKey, signedIdentityKey: identityKey } = this.sock.authState.creds
		const fromJid = node.attrs.from!

		// Check if we should recreate the session
		let shouldRecreateSession = false
		let recreateReason = ''

		if (this.config.enableAutoSessionRecreation && this.sock.messageRetryManager && retryCount > 1) {
			try {
				// Check if we have a session with this JID
				const sessionId = this.sock.signalRepository.jidToSignalProtocolAddress(fromJid)
				const hasSession = await this.sock.signalRepository.validateSession(fromJid)
				const result = this.sock.messageRetryManager.shouldRecreateSession(fromJid, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason

				if (shouldRecreateSession) {
					this.config.logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry')
					// Delete existing session to force recreation
					await this.sock.authState.keys.set({ session: { [sessionId]: null } })
					forceIncludeKeys = true
				}
			} catch (error) {
				this.config.logger.warn({ error, fromJid }, 'failed to check session recreation')
			}
		}

		if (retryCount <= 2) {
			// Use new retry manager for phone requests if available
			if (this.sock.messageRetryManager) {
				// Schedule phone request with delay (like whatsmeow)
				this.sock.messageRetryManager.schedulePhoneRequest(msgId, async () => {
					try {
						const requestId = await this.requestPlaceholderResend(msgKey)
						this.config.logger.debug(
							`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`
						)
					} catch (error) {
						this.config.logger.warn({ error, msgId }, 'failed to send scheduled phone request')
					}
				})
			} else {
				// Fallback to immediate request
				const msgId = await this.requestPlaceholderResend(msgKey)
				this.config.logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`)
			}
		}

		const deviceIdentity = encodeSignedDeviceIdentity(account!, true)
		await this.sock.authState.keys.transaction(async () => {
			const receipt: BinaryNode = {
				tag: 'receipt',
				attrs: {
					id: msgId,
					type: 'retry',
					to: node.attrs.from!
				},
				content: [
					{
						tag: 'retry',
						attrs: {
							count: retryCount.toString(),
							id: node.attrs.id!,
							t: node.attrs.t!,
							v: '1',
							// ADD ERROR FIELD
							error: '0'
						}
					},
					{
						tag: 'registration',
						attrs: {},
						content: encodeBigEndian(this.sock.authState.creds.registrationId)
					}
				]
			}

			if (node.attrs.recipient) {
				receipt.attrs.recipient = node.attrs.recipient
			}

			if (node.attrs.participant) {
				receipt.attrs.participant = node.attrs.participant
			}

			if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
				const { update, preKeys } = await getNextPreKeys(this.sock.authState, 1)

				const [keyId] = Object.keys(preKeys)
				const key = preKeys[+keyId!]

				const content = receipt.content! as BinaryNode[]
				content.push({
					tag: 'keys',
					attrs: {},
					content: [
						{ tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
						{ tag: 'identity', attrs: {}, content: identityKey.public },
						xmppPreKey(key!, +keyId!),
						xmppSignedPreKey(signedPreKey),
						{ tag: 'device-identity', attrs: {}, content: deviceIdentity }
					]
				})

				this.sock.ev.emit('creds.update', update)
			}

			await this.sock.sendNode(receipt)

			this.config.logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')
		}, this.sock.authState?.creds?.me?.id || 'this.sendRetryRequest')
	}

	/**
	 * Fire-and-forget tctoken re-issuance after a peer's device identity changed.
	 * Mirrors WAWebSendTcTokenWhenDeviceIdentityChange — runs in parallel with
	 * the session refresh (not after it).
	 */
	public reissueTcTokenAfterIdentityChange = (from: string): void => {
		void (async () => {
			const normalizedJid = jidNormalizedUser(from)
			const tcJid = await resolveTcTokenJid(normalizedJid, this.getLIDForPN)
			const tcTokenData = await this.sock.authState.keys.get('tctoken', [tcJid])
			const senderTs = tcTokenData?.[tcJid]?.senderTimestamp

			if (senderTs === null || senderTs === undefined || isTcTokenExpired(senderTs)) {
				return
			}

			this.config.logger.debug(
				{ jid: normalizedJid, senderTimestamp: senderTs },
				'identity changed, re-issuing tctoken'
			)
			const getPNForLID = this.sock.signalRepository.lidMapping.getPNForLID.bind(this.sock.signalRepository.lidMapping)
			const issueJid = await resolveIssuanceJid(
				normalizedJid,
				this.sock.serverProps.lidTrustedTokenIssueToLid,
				this.getLIDForPN,
				getPNForLID
			)
			const result = await this.sock.issuePrivacyTokens([issueJid], senderTs)
			await storeTcTokensFromIqResult({
				result,
				fallbackJid: tcJid,
				keys: this.sock.authState.keys,
				getLIDForPN: this.getLIDForPN,
				onNewJidStored: this.trackTcTokenJid
			})
		})().catch(err => {
			this.config.logger.debug({ jid: from, err: err?.message }, 'failed to re-issue tctoken after identity change')
		})
	}

	public handleEncryptNotification = async (node: BinaryNode) => {
		const from = node.attrs.from
		if (from === S_WHATSAPP_NET) {
			const stanzaId = node.attrs.id
			if (stanzaId && this.inFlightPreKeyLow.has(stanzaId)) {
				return
			}

			const countChild = getBinaryNodeChild(node, 'count')
			const count = +countChild!.attrs.value!
			const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT

			this.config.logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
			if (shouldUploadMorePreKeys) {
				if (stanzaId) this.inFlightPreKeyLow.add(stanzaId)
				try {
					await this.sock.uploadPreKeys()
				} finally {
					if (stanzaId) this.inFlightPreKeyLow.delete(stanzaId)
				}
			}
		} else {
			const result = await handleIdentityChange(node, {
				meId: this.sock.authState.creds.me?.id,
				meLid: this.sock.authState.creds.me?.lid,
				validateSession: this.sock.signalRepository.validateSession,
				assertSessions: this.sock.assertSessions,
				debounceCache: this.identityAssertDebounce,
				logger: this.config.logger,
				onBeforeSessionRefresh: this.reissueTcTokenAfterIdentityChange,
				clearSession: async jid => {
					const sessionId = this.sock.signalRepository.jidToSignalProtocolAddress(jid)
					await this.sock.authState.keys.set({ session: { [sessionId]: null } })
				}
			})

			if (result.action === 'no_identity_node') {
				this.config.logger.info({ node }, 'unknown encrypt notification')
			}
		}
	}

	public handleGroupNotification = (fullNode: BinaryNode, child: BinaryNode, msg: Partial<WAMessage>) => {
		// TODO: Support PN/LID (Here is only LID now)

		const actingParticipantLid = fullNode.attrs.participant
		const actingParticipantPn = fullNode.attrs.participant_pn
		const actingParticipantUsername = fullNode.attrs.participant_username

		const affectedParticipantLid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid!
		const affectedParticipantPn = getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn!

		switch (child?.tag) {
			case 'create':
				const metadata = extractGroupMetadata(child)

				msg.messageStubType = WAMessageStubType.GROUP_CREATE
				msg.messageStubParameters = [metadata.subject]
				msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn }

				this.sock.ev.emit('chats.upsert', [
					{
						id: metadata.id,
						name: metadata.subject,
						conversationTimestamp: metadata.creation
					}
				])
				this.sock.ev.emit('groups.upsert', [
					{
						...metadata,
						author: actingParticipantLid,
						authorPn: actingParticipantPn,
						authorUsername: actingParticipantUsername
					}
				])
				break
			case 'ephemeral':
			case 'not_ephemeral':
				msg.message = {
					protocolMessage: {
						type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
						ephemeralExpiration: +(child.attrs.expiration || 0)
					}
				}
				break
			case 'modify':
				const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid!)
				msg.messageStubParameters = oldNumber || []
				msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER
				break
			case 'promote':
			case 'demote':
			case 'remove':
			case 'add':
			case 'leave':
				const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`
				msg.messageStubType = WAMessageStubType[stubType as keyof typeof WAMessageStubType]

				const participants = getBinaryNodeChildren(child, 'participant').map(({ attrs }) => {
					// TODO: Store LID MAPPINGS
					return {
						id: attrs.jid!,
						phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
						lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
						username: attrs.participant_username || attrs.username || undefined,
						admin: (attrs.type || null) as GroupParticipant['admin']
					}
				})

				if (
					participants.length === 1 &&
					// if recv. "remove" message and sender removed themselves
					// mark as left
					(areJidsSameUser(participants[0]!.id, actingParticipantLid) ||
						areJidsSameUser(participants[0]!.id, actingParticipantPn)) &&
					child.tag === 'remove'
				) {
					msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE
				}

				msg.messageStubParameters = participants.map(a => JSON.stringify(a))
				break
			case 'subject':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
				msg.messageStubParameters = [child.attrs.subject!]
				break
			case 'description':
				const description = getBinaryNodeChild(child, 'body')?.content?.toString()
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION
				msg.messageStubParameters = description ? [description] : undefined
				break
			case 'announcement':
			case 'not_announcement':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
				msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off']
				break
			case 'locked':
			case 'unlocked':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
				msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off']
				break
			case 'invite':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK
				msg.messageStubParameters = [child.attrs.code!]
				break
			case 'member_add_mode':
				const addMode = child.content
				if (addMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE
					msg.messageStubParameters = [addMode.toString()]
				}

				break
			case 'membership_approval_mode':
				const approvalMode = getBinaryNodeChild(child, 'group_join')
				if (approvalMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE
					msg.messageStubParameters = [approvalMode.attrs.state!]
				}

				break
			case 'created_membership_requests':
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
					'created',
					child.attrs.request_method!
				]
				break
			case 'revoked_membership_requests':
				const isDenied = areJidsSameUser(affectedParticipantLid, actingParticipantLid)
				// TODO: LIDMAPPING SUPPORT
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
					isDenied ? 'revoked' : 'rejected'
				]
				break
		}
	}

	public handleDevicesNotification = async (node: BinaryNode) => {
		const [child] = getAllBinaryNodeChildren(node)
		const from = jidNormalizedUser(node.attrs.from)

		if (!child) {
			this.config.logger.debug({ from }, 'devices notification missing child, skipping')
			return
		}

		const tag = child.tag as 'add' | 'remove' | 'update'
		const deviceHash = child.attrs.device_hash
		const devices = getBinaryNodeChildren(child, 'device')

		if (
			areJidsSameUser(from, this.sock.authState.creds.me!.id) ||
			areJidsSameUser(from, this.sock.authState.creds.me!.lid)
		) {
			const deviceJids = devices.map(d => d.attrs.jid)
			this.config.logger.info({ deviceJids }, 'got my own devices')
		}

		if (!devices.length) {
			this.config.logger.debug({ from, tag }, 'no devices in notification, skipping')
			return
		}

		type DecodedDevice = { jid: string; user: string; server: string; device?: number }
		const decoded: DecodedDevice[] = []
		for (const d of devices) {
			const jid = d.attrs.jid
			if (!jid) continue
			const parts = jidDecode(jid)
			if (!parts) {
				this.config.logger.debug({ jid }, 'failed to decode device jid, skipping')
				continue
			}

			decoded.push({ jid, user: parts.user, server: parts.server, device: parts.device })
		}

		if (!decoded.length) return

		await this.sock.devicesMutex.mutex(async () => {
			const byUser = new Map<string, DecodedDevice[]>()
			for (const d of decoded) {
				const list = byUser.get(d.user) || []
				list.push(d)
				byUser.set(d.user, list)
			}

			for (const [user, entries] of byUser) {
				if (tag === 'update') {
					this.config.logger.debug({ user }, `${user}'s device list updated, dropping cached devices`)
					await this.sock.userDevicesCache?.del(user)
					continue
				}

				if (tag === 'remove') {
					await this.sock.signalRepository.deleteSession(entries.map(e => e.jid))
				}

				const existingCache: JidWithDevice[] = (await this.sock.userDevicesCache?.get<JidWithDevice[]>(user)) || []
				if (!existingCache.length) {
					// No baseline yet; skip applying the delta so getUSyncDevices can
					// later fetch the full device list. Caching just the notification
					// entries would make a partial list look authoritative.
					this.config.logger.debug({ user, tag }, 'device list not cached, deferring to USync refresh')
					continue
				}

				const affected = new Set(entries.map(e => e.device))
				let updatedDevices: JidWithDevice[]
				switch (tag) {
					case 'add':
						this.config.logger.info({ deviceHash, count: entries.length }, 'devices added')
						updatedDevices = [
							...existingCache.filter(d => !affected.has(d.device)),
							...entries.map(e => ({ user: e.user, server: e.server, device: e.device }))
						]
						break
					case 'remove':
						this.config.logger.info({ deviceHash, count: entries.length }, 'devices removed')
						updatedDevices = existingCache.filter(d => !affected.has(d.device))
						break
					default:
						this.config.logger.debug({ tag }, 'Unknown device list change tag')
						continue
				}

				if (updatedDevices.length === 0) {
					await this.sock.userDevicesCache?.del(user)
				} else {
					await this.sock.userDevicesCache?.set(user, updatedDevices)
				}
			}
		})
	}

	public processNotification = async (node: BinaryNode) => {
		const result: Partial<WAMessage> = {}
		const [child] = getAllBinaryNodeChildren(node)
		const nodeType = node.attrs.type
		const from = jidNormalizedUser(node.attrs.from)

		switch (nodeType) {
			case 'newsletter':
				await this.handleNewsletterNotification(node)
				break
			case 'mex':
				await this.handleMexNotification(node)
				break
			case 'w:gp2':
				// TODO: HANDLE PARTICIPANT_PN
				this.handleGroupNotification(node, child!, result)
				break
			case 'mediaretry':
				const event = decodeMediaRetryNode(node)
				this.sock.ev.emit('messages.media-update', [event])
				break
			case 'encrypt':
				await this.handleEncryptNotification(node)
				break
			case 'devices':
				try {
					await this.handleDevicesNotification(node)
				} catch (error) {
					this.config.logger.error({ error, node }, 'failed to handle devices notification')
				}

				break
			case 'server_sync':
				const update = getBinaryNodeChild(node, 'collection')
				if (update) {
					const name = update.attrs.name as WAPatchName
					await this.sock.resyncAppState([name], false)
				}

				break
			case 'picture':
				const setPicture = getBinaryNodeChild(node, 'set')
				const delPicture = getBinaryNodeChild(node, 'delete')

				// TODO: WAJIDHASH stuff proper support inhouse
				this.sock.ev.emit('contacts.update', [
					{
						id: jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
						imgUrl: setPicture ? 'changed' : 'removed'
					}
				])

				if (isJidGroup(from)) {
					const node = setPicture || delPicture
					result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON

					if (setPicture) {
						result.messageStubParameters = [setPicture.attrs.id!]
					}

					result.participant = node?.attrs.author
					result.key = {
						...(result.key || {}),
						participant: setPicture?.attrs.author
					}
				}

				break
			case 'account_sync':
				if (child!.tag === 'disappearing_mode') {
					const newDuration = +child!.attrs.duration!
					const timestamp = +child!.attrs.t!

					this.config.logger.info({ newDuration }, 'updated account disappearing mode')

					this.sock.ev.emit('creds.update', {
						accountSettings: {
							...this.sock.authState.creds.accountSettings,
							defaultDisappearingMode: {
								ephemeralExpiration: newDuration,
								ephemeralSettingTimestamp: timestamp
							}
						}
					})
				} else if (child!.tag === 'blocklist') {
					const blocklists = getBinaryNodeChildren(child, 'item')

					for (const { attrs } of blocklists) {
						const blocklist = [attrs.jid!]
						const type = attrs.action === 'block' ? 'add' : 'remove'
						this.sock.ev.emit('blocklist.update', { blocklist, type })
					}
				}

				break
			case 'link_code_companion_reg':
				const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg')
				const ref = this.toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'))
				const primaryIdentityPublicKey = this.toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub')
				)
				const primaryEphemeralPublicKeyWrapped = this.toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub')
				)
				const codePairingPublicKey = await this.decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped)
				const companionSharedKey = Curve.sharedKey(
					this.sock.authState.creds.pairingEphemeralKeyPair.private,
					codePairingPublicKey
				)
				const random = randomBytes(32)
				const linkCodeSalt = randomBytes(32)
				const linkCodePairingExpanded = hkdf(companionSharedKey, 32, {
					salt: linkCodeSalt,
					info: 'link_code_pairing_key_bundle_encryption_key'
				})
				const encryptPayload = Buffer.concat([
					Buffer.from(this.sock.authState.creds.signedIdentityKey.public),
					primaryIdentityPublicKey,
					random
				])
				const encryptIv = randomBytes(12)
				const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0))
				const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted])
				const identitySharedKey = Curve.sharedKey(
					this.sock.authState.creds.signedIdentityKey.private,
					primaryIdentityPublicKey
				)
				const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random])
				this.sock.authState.creds.advSecretKey = Buffer.from(
					hkdf(identityPayload, 32, { info: 'adv_secret' })
				).toString('base64')
				await this.sock.query({
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						id: this.sock.generateMessageTag(),
						xmlns: 'md'
					},
					content: [
						{
							tag: 'link_code_companion_reg',
							attrs: {
								jid: this.sock.authState.creds.me!.id,
								stage: 'companion_finish'
							},
							content: [
								{
									tag: 'link_code_pairing_wrapped_key_bundle',
									attrs: {},
									content: encryptedPayload
								},
								{
									tag: 'companion_identity_public',
									attrs: {},
									content: this.sock.authState.creds.signedIdentityKey.public
								},
								{
									tag: 'link_code_pairing_ref',
									attrs: {},
									content: ref
								}
							]
						}
					]
				})
				this.sock.authState.creds.registered = true
				this.sock.ev.emit('creds.update', this.sock.authState.creds)
				break
			case 'privacy_token':
				await this.handlePrivacyTokenNotification(node)
				break
		}

		if (Object.keys(result).length) {
			return result
		}
	}

	/**
	 * In-memory cache of storage JIDs with stored tctokens, seeded from the persisted index.
	 * Used to coalesce writes during a session; pruning always re-reads the persisted index
	 * to cover writes made by other layers (e.g. history sync).
	 */

	public flushTcTokenIndex = async () => {
		if (this.tcTokenIndexTimer) {
			clearTimeout(this.tcTokenIndexTimer)
			this.tcTokenIndexTimer = undefined
		}

		// Merge with whatever is already persisted so we don't clobber writes from other
		// paths (history sync, concurrent sessions on the same store).
		const write = await buildMergedTcTokenIndexWrite(this.sock.authState.keys, this.tcTokenKnownJids)
		return this.sock.authState.keys.set({ tctoken: write })
	}

	public scheduleTcTokenIndexSave = () => {
		if (this.tcTokenIndexTimer) {
			clearTimeout(this.tcTokenIndexTimer)
		}

		this.tcTokenIndexTimer = setTimeout(() => {
			this.tcTokenIndexTimer = undefined
			this.flushTcTokenIndex().catch(err => {
				this.config.logger.warn({ err: err?.message }, 'failed to save tctoken index')
			})
		}, 5000)
	}

	public trackTcTokenJid = (jid: string) => {
		if (jid && jid !== TC_TOKEN_INDEX_KEY && !this.tcTokenKnownJids.has(jid)) {
			this.tcTokenKnownJids.add(jid)
			this.scheduleTcTokenIndexSave()
		}
	}

	public handlePrivacyTokenNotification = async (node: BinaryNode) => {
		const tokensNode = getBinaryNodeChild(node, 'tokens')
		if (!tokensNode) return

		const from = jidNormalizedUser(node.attrs.from)

		// WA Web uses: senderLid ?? toLid(from) for the storage key
		// The sender_lid attribute provides the LID directly when available
		const senderLid =
			node.attrs.sender_lid && isLidUser(jidNormalizedUser(node.attrs.sender_lid))
				? jidNormalizedUser(node.attrs.sender_lid)
				: undefined
		const fallbackJid = senderLid ?? (await resolveTcTokenJid(from, this.getLIDForPN))

		this.config.logger.debug({ from, storageJid: fallbackJid }, 'processing privacy token notification')

		await storeTcTokensFromIqResult({
			result: node,
			fallbackJid,
			keys: this.sock.authState.keys,
			getLIDForPN: this.getLIDForPN,
			onNewJidStored: this.trackTcTokenJid
		})
	}

	public decipherLinkPublicKey = async (data: Uint8Array | Buffer) => {
		const buffer = this.toRequiredBuffer(data)
		const salt = buffer.slice(0, 32)
		const secretKey = await derivePairingCodeKey(this.sock.authState.creds.pairingCode!, salt)
		const iv = buffer.slice(32, 48)
		const payload = buffer.slice(48, 80)
		return aesDecryptCTR(payload, secretKey, iv)
	}

	public toRequiredBuffer = (data: Uint8Array | Buffer | undefined) => {
		if (data === undefined) {
			throw new Boom('Invalid buffer', { statusCode: 400 })
		}

		return data instanceof Buffer ? data : Buffer.from(data)
	}

	public willSendMessageAgain = async (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const retryCount = (await this.msgRetryCache.get(key)) || 0
		return retryCount < this.config.maxMsgRetryCount
	}

	public updateSendMessageAgainCount = async (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const newValue = ((await this.msgRetryCache.get(key)) || 0) + 1
		await this.msgRetryCache.set(key, newValue)
	}

	public sendMessagesAgain = async (
		key: WAMessageKey,
		ids: string[],
		retryNode: BinaryNode,
		receiptNode: BinaryNode
	) => {
		const remoteJid = key.remoteJid!
		const participant = key.participant || remoteJid

		const retryCount = +retryNode.attrs.count! || 1
		const msgId = ids[0]

		// Try to get messages from cache first, then fallback to this.config.getMessage
		const msgs: (proto.IMessage | undefined)[] = []
		for (const id of ids) {
			let msg: proto.IMessage | undefined

			// Try to get from retry cache first if enabled
			if (this.sock.messageRetryManager) {
				const cachedMsg = this.sock.messageRetryManager.getRecentMessage(remoteJid, id)
				if (cachedMsg) {
					msg = cachedMsg.message
					this.config.logger.debug({ jid: remoteJid, id }, 'found message in retry cache')

					// Mark retry as successful since we found the message
					this.sock.messageRetryManager.markRetrySuccess(id)
				}
			}

			// Fallback to this.config.getMessage if not found in cache
			if (!msg) {
				msg = await this.config.getMessage({ ...key, id })
				if (msg) {
					this.config.logger.debug({ jid: remoteJid, id }, 'found message via this.config.getMessage')
					// Also mark as successful if found via this.config.getMessage
					if (this.sock.messageRetryManager) {
						this.sock.messageRetryManager.markRetrySuccess(id)
					}
				}
			}

			msgs.push(msg)
		}

		// if it's the primary jid sending the request
		// just re-send the message to everyone
		// prevents the first message decryption failure
		const sendToAll = !jidDecode(participant)?.device

		const sessionId = this.sock.signalRepository.jidToSignalProtocolAddress(participant)
		let injectedFromBundle = false

		const bundle = extractE2ESessionFromRetryReceipt(receiptNode)
		if (bundle) {
			try {
				await this.sock.signalRepository.injectE2ESession({ jid: participant, session: bundle })
				injectedFromBundle = true
				this.config.logger.debug({ participant, retryCount }, 'injected session from retry receipt key bundle')
			} catch (error) {
				this.config.logger.warn({ error, participant }, 'failed to inject session from retry receipt')
			}
		}

		if (!injectedFromBundle) {
			const receivedRegId = getBinaryNodeChildUInt(receiptNode, 'registration', 4)
			if (typeof receivedRegId === 'number' && Number.isInteger(receivedRegId)) {
				const info = await this.sock.signalRepository.getSessionInfo(participant)
				if (info && info.registrationId !== 0 && info.registrationId !== receivedRegId) {
					this.config.logger.info(
						{ participant, stored: info.registrationId, received: receivedRegId },
						'reg id mismatch on retry without bundle, deleting session'
					)
					await this.sock.authState.keys.set({ session: { [sessionId]: null } })
				}
			}
		}

		const BASE_KEY_CHECK_RETRY = 2
		if (msgId && this.sock.messageRetryManager) {
			const info = await this.sock.signalRepository.getSessionInfo(participant)
			if (info) {
				if (retryCount === BASE_KEY_CHECK_RETRY) {
					this.sock.messageRetryManager.saveBaseKey(sessionId, msgId, info.baseKey)
				} else if (retryCount > BASE_KEY_CHECK_RETRY) {
					if (this.sock.messageRetryManager.hasSameBaseKey(sessionId, msgId, info.baseKey)) {
						this.config.logger.warn({ participant, retryCount }, 'base key collision on retry, forcing fresh session')
						await this.sock.authState.keys.set({ session: { [sessionId]: null } })
					}

					this.sock.messageRetryManager.deleteBaseKey(sessionId, msgId)
				}
			}
		}

		let shouldRecreateSession = false
		let recreateReason = ''

		if (
			this.config.enableAutoSessionRecreation &&
			this.sock.messageRetryManager &&
			retryCount > 1 &&
			!injectedFromBundle
		) {
			try {
				const hasSession = await this.sock.signalRepository.validateSession(participant)
				const result = this.sock.messageRetryManager.shouldRecreateSession(participant, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason

				if (shouldRecreateSession) {
					this.config.logger.debug(
						{ participant, retryCount, reason: recreateReason },
						'recreating session for outgoing retry'
					)
					await this.sock.authState.keys.set({ session: { [sessionId]: null } })
				}
			} catch (error) {
				this.config.logger.warn({ error, participant }, 'failed to check session recreation for outgoing retry')
			}
		}

		if (!injectedFromBundle) {
			await this.sock.assertSessions([participant], true)
		}

		if (isJidGroup(remoteJid)) {
			await this.sock.authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
		}

		this.config.logger.debug(
			{ participant, sendToAll, shouldRecreateSession, recreateReason, injectedFromBundle },
			'prepared session for retry resend'
		)

		for (const [i, msg] of msgs.entries()) {
			if (!ids[i]) continue

			if (msg && (await this.willSendMessageAgain(ids[i], participant))) {
				await this.updateSendMessageAgainCount(ids[i], participant)
				const msgRelayOpts: MessageRelayOptions = { messageId: ids[i] }

				if (sendToAll) {
					msgRelayOpts.useUserDevicesCache = false
				} else {
					msgRelayOpts.participant = {
						jid: participant,
						count: +retryNode.attrs.count!
					}
				}

				await this.sock.relayMessage(key.remoteJid!, msg, msgRelayOpts)
			} else {
				this.config.logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
			}
		}
	}

	public handleReceipt = async (node: BinaryNode) => {
		const { attrs, content } = node
		const isLid = attrs.from!.includes('lid')
		const isNodeFromMe = areJidsSameUser(
			attrs.participant || attrs.from,
			isLid ? this.sock.authState.creds.me?.lid : this.sock.authState.creds.me?.id
		)
		const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe)

		const key: proto.IMessageKey = {
			remoteJid,
			id: '',
			fromMe,
			participant: attrs.participant
		}

		const ids = [attrs.id!]
		if (Array.isArray(content)) {
			const items = getBinaryNodeChildren(content[0], 'item')
			ids.push(...items.map(i => i.attrs.id!))
		}

		try {
			await Promise.all([
				this.sock.receiptMutex.mutex(async () => {
					const status = getStatusFromReceiptType(attrs.type)
					if (
						typeof status !== 'undefined' &&
						// basically, we only want to know when a message from us has been delivered to/read by the other person
						// or another device of ours has read some messages
						(status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)
					) {
						if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid!)) {
							if (attrs.participant) {
								const updateKey: keyof MessageUserReceipt =
									status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
								this.sock.ev.emit(
									'message-receipt.update',
									ids.map(id => ({
										key: { ...key, id },
										receipt: {
											userJid: jidNormalizedUser(attrs.participant),
											[updateKey]: +attrs.t!
										}
									}))
								)
							}
						} else {
							this.sock.ev.emit(
								'messages.update',
								ids.map(id => ({
									key: { ...key, id },
									update: { status, messageTimestamp: toNumber(+(attrs.t ?? 0)) }
								}))
							)
						}
					}

					if (attrs.type === 'retry') {
						// correctly set who is asking for the retry
						key.participant = key.participant || attrs.from
						const retryNode = getBinaryNodeChild(node, 'retry')
						if (ids[0] && key.participant && (await this.willSendMessageAgain(ids[0], key.participant))) {
							if (key.fromMe) {
								try {
									await this.updateSendMessageAgainCount(ids[0], key.participant)
									this.config.logger.debug({ attrs, key }, 'recv retry request')
									await this.sendMessagesAgain(key, ids, retryNode!, node)
								} catch (error: unknown) {
									this.config.logger.error(
										{ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' },
										'error in sending message again'
									)
								}
							} else {
								this.config.logger.info({ attrs, key }, 'recv retry for not fromMe message')
							}
						} else {
							this.config.logger.info({ attrs, key }, 'will not send message again, as sent too many times')
						}
					}
				})
			])
		} finally {
			await this.sendMessageAck(node).catch(ackErr => this.config.logger.error({ ackErr }, 'failed to ack receipt'))
		}
	}

	public handleNotification = async (node: BinaryNode) => {
		const remoteJid = node.attrs.from

		try {
			await Promise.all([
				this.sock.notificationMutex.mutex(async () => {
					const msg = await this.processNotification(node)
					if (msg) {
						const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, this.sock.authState.creds.me!.id)
						const { senderAlt: participantAlt, addressingMode } = extractAddressingContext(node)
						msg.key = {
							remoteJid,
							fromMe,
							participant: node.attrs.participant,
							participantAlt,
							participantUsername: node.attrs.participant_username,
							addressingMode,
							id: node.attrs.id,
							...(msg.key || {})
						}
						msg.participant ??= node.attrs.participant
						msg.messageTimestamp = +node.attrs.t!

						const fullMsg = proto.WebMessageInfo.fromObject(msg) as WAMessage
						await this.sock.upsertMessage(fullMsg, 'append')
					}
				})
			])
		} finally {
			await this.sendMessageAck(node).catch(ackErr =>
				this.config.logger.error({ ackErr }, 'failed to ack notification')
			)
		}
	}

	public handleMessage = async (node: BinaryNode) => {
		const encNode = getBinaryNodeChild(node, 'enc')
		// TODO: temporary fix for crashes and issues resulting of failed msmsg decryption
		if (encNode?.attrs.type === 'msmsg') {
			this.config.logger.debug({ key: node.attrs.key }, 'ignored msmsg')
			await this.sendMessageAck(node, NACK_REASONS.MissingMessageSecret)
			return
		}

		let acked = false

		try {
			const {
				fullMessage: msg,
				category,
				author,
				decrypt
			} = decryptMessageNode(
				node,
				this.sock.authState.creds.me!.id,
				this.sock.authState.creds.me!.lid || '',
				this.sock.signalRepository,
				this.config.logger
			)

			const senderJid = msg.key.participant || msg.key.remoteJid!
			await storeTcTokenFromMessage(
				node,
				senderJid,
				this.sock.authState.keys,
				this.sock.signalRepository.lidMapping.getLIDForPN.bind(this.sock.signalRepository.lidMapping),
				this.trackTcTokenJid
			).catch(err => {
				this.config.logger.warn({ err, senderJid }, 'failed to store tctoken from incoming message')
			})

			const alt = msg.key.participantAlt || msg.key.remoteJidAlt
			// store new mappings we didn't have before
			if (!!alt) {
				const altServer = jidDecode(alt)?.server
				const primaryJid = msg.key.participant || msg.key.remoteJid!
				if (altServer === 'lid') {
					if (!(await this.sock.signalRepository.lidMapping.getPNForLID(alt))) {
						await this.sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }])
						await this.sock.signalRepository.migrateSession(primaryJid, alt)
					}
				} else {
					await this.sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid: primaryJid, pn: alt }])
					await this.sock.signalRepository.migrateSession(alt, primaryJid)
				}
			}

			await this.sock.messageMutex.mutex(async () => {
				await decrypt()

				if (msg.key?.remoteJid && msg.key?.id && msg.message && this.sock.messageRetryManager) {
					this.sock.messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message)
				}

				// message failed to decrypt
				if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
					if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
						acked = true
						return this.sendMessageAck(node, NACK_REASONS.ParsingError)
					}

					if (msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
						// Message arrived without encryption (e.g. CTWA ads messages).
						// Check if this is eligible for placeholder resend (matching WA Web filters).
						const unavailableNode = getBinaryNodeChild(node, 'unavailable')
						const unavailableType = unavailableNode?.attrs?.type
						if (
							unavailableType === 'bot_unavailable_fanout' ||
							unavailableType === 'hosted_unavailable_fanout' ||
							unavailableType === 'view_once_unavailable_fanout'
						) {
							this.config.logger.debug(
								{ msgId: msg.key.id, unavailableType },
								'skipping placeholder resend for excluded unavailable type'
							)
							acked = true
							return this.sendMessageAck(node)
						}

						const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp)
						if (messageAge > PLACEHOLDER_MAX_AGE_SECONDS) {
							this.config.logger.debug({ msgId: msg.key.id, messageAge }, 'skipping placeholder resend for old message')
							acked = true
							return this.sendMessageAck(node)
						}

						// Request the real content from the phone via placeholder resend PDO.
						// Upsert the CIPHERTEXT stub as a placeholder (like WA Web's processPlaceholderMsg),
						// and store the requestId in stubParameters[1] so users can correlate
						// with the incoming PDO response event.
						const cleanKey: proto.IMessageKey = {
							remoteJid: msg.key.remoteJid,
							fromMe: msg.key.fromMe,
							id: msg.key.id,
							participant: msg.key.participant
						}
						// Cache the original message metadata so the PDO response handler
						// can preserve key fields (LID details etc.) that the phone may omit
						const msgData: Partial<WAMessage> = {
							key: msg.key,
							messageTimestamp: msg.messageTimestamp,
							pushName: msg.pushName,
							participant: msg.participant,
							verifiedBizName: msg.verifiedBizName
						}
						this.requestPlaceholderResend(cleanKey, msgData)
							.then(requestId => {
								if (requestId && requestId !== 'RESOLVED') {
									this.config.logger.debug(
										{ msgId: msg.key.id, requestId },
										'requested placeholder resend for unavailable message'
									)
									this.sock.ev.emit('messages.update', [
										{
											key: msg.key,
											update: { messageStubParameters: [NO_MESSAGE_FOUND_ERROR_TEXT, requestId] }
										}
									])
								}
							})
							.catch(err => {
								this.config.logger.warn(
									{ err, msgId: msg.key.id },
									'failed to request placeholder resend for unavailable message'
								)
							})
						acked = true
						await this.sendMessageAck(node)
						// Don't return — fall through to this.sock.upsertMessage so the stub is emitted
					} else {
						// Skip retry for expired status messages (>24h old)
						if (isJidStatusBroadcast(msg.key.remoteJid!)) {
							const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp)
							if (messageAge > STATUS_EXPIRY_SECONDS) {
								this.config.logger.debug(
									{ msgId: msg.key.id, messageAge, remoteJid: msg.key.remoteJid },
									'skipping retry for expired status message'
								)
								acked = true
								return this.sendMessageAck(node)
							}
						}

						this.config.logger.debug('[this.handleMessage] Attempting retry request for failed decryption')

						// WAWeb only retry-receipts here; server emits PreKeyLow if prekeys run low.
						await this.retryMutex.mutex(async () => {
							try {
								if (!this.sock.ws.isOpen) {
									this.config.logger.debug({ node }, 'Connection closed, skipping retry')
									return
								}

								const encNode = getBinaryNodeChild(node, 'enc')
								await this.sendRetryRequest(node, !encNode)
								if (this.config.retryRequestDelayMs) {
									await delay(this.config.retryRequestDelayMs)
								}
							} catch (err) {
								this.config.logger.error({ err }, 'Failed to send retry')
							}

							acked = true
							await this.sendMessageAck(node, NACK_REASONS.UnhandledError)
						})
					}
				} else {
					if (this.sock.messageRetryManager && msg.key.id) {
						this.sock.messageRetryManager.cancelPendingPhoneRequest(msg.key.id)
					}

					const isNewsletter = isJidNewsletter(msg.key.remoteJid!)
					if (!isNewsletter) {
						// no type in the receipt => message delivered
						let type: MessageReceiptType = undefined
						let participant = msg.key.participant
						if (category === 'peer') {
							// special peer message
							type = 'peer_msg'
						} else if (msg.key.fromMe) {
							// message was sent by us from a different device
							type = 'sender'
							// need to specially handle this case
							if (isLidUser(msg.key.remoteJid!) || isLidUser(msg.key.remoteJidAlt)) {
								participant = author // TODO: investigate sending receipts to LIDs and not PNs
							}
						} else if (!this.sendActiveReceipts) {
							type = 'inactive'
						}

						acked = true
						await this.sock.sendReceipt(msg.key.remoteJid!, participant!, [msg.key.id!], type)

						// send ack for history message
						const isAnyHistoryMsg = getHistoryMsg(msg.message!)
						if (isAnyHistoryMsg) {
							const jid = jidNormalizedUser(msg.key.remoteJid!)
							await this.sock.sendReceipt(jid, undefined, [msg.key.id!], 'hist_sync') // TODO: investigate
						}
					} else {
						acked = true
						await this.sendMessageAck(node)
						this.config.logger.debug({ key: msg.key }, 'processed newsletter message without receipts')
					}
				}

				cleanMessage(msg, this.sock.authState.creds.me!.id, this.sock.authState.creds.me!.lid!)

				await this.sock.upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')
			})
		} catch (error) {
			this.config.logger.error({ error, node: binaryNodeToString(node) }, 'error in handling message')
			if (!acked) {
				await this.sendMessageAck(node, NACK_REASONS.UnhandledError).catch(ackErr =>
					this.config.logger.error({ ackErr }, 'failed to ack message after error')
				)
			}
		}
	}

	public handleCall = async (node: BinaryNode) => {
		try {
			const { attrs } = node
			const [infoChild] = getAllBinaryNodeChildren(node)

			if (!infoChild) {
				throw new Boom('Missing call info in call node')
			}

			const status = getCallStatusFromNode(infoChild)

			const callId = infoChild.attrs['call-id']!
			const from = infoChild.attrs.from! || infoChild.attrs['call-creator']!

			const call: WACallEvent = {
				chatId: attrs.from!,
				from,
				callerPn: infoChild.attrs['caller_pn'],
				id: callId,
				date: new Date(+attrs.t! * 1000),
				offline: !!attrs.offline,
				status
			}

			if (status === 'relaylatency') {
				const latencyValue = infoChild.attrs.latency || infoChild.attrs['latency_ms'] || infoChild.attrs['latency-ms']
				const latencyMs = latencyValue ? Number(latencyValue) : undefined
				if (Number.isFinite(latencyMs)) {
					call.latencyMs = latencyMs
				}
			}

			if (status === 'offer') {
				call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
				call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid']
				call.groupJid = infoChild.attrs['group-jid']
				await this.callOfferCache.set(call.id, call)
			}

			const existingCall = await this.callOfferCache.get(call.id)

			// use existing call info to populate this event
			if (existingCall) {
				call.isVideo = existingCall.isVideo
				call.isGroup = existingCall.isGroup
				call.callerPn = call.callerPn || existingCall.callerPn
			}

			// delete data once call has ended
			if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
				await this.callOfferCache.del(call.id)
			}

			this.sock.ev.emit('call', [call])
		} catch (error) {
			this.config.logger.error({ error, node: binaryNodeToString(node) }, 'error in handling call')
		} finally {
			await this.sendMessageAck(node).catch(ackErr => this.config.logger.error({ ackErr }, 'failed to ack call'))
		}
	}

	public handleBadAck = async ({ attrs }: BinaryNode) => {
		const key: WAMessageKey = { remoteJid: attrs.from, fromMe: true, id: attrs.id }

		// WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
		// // current hypothesis is that if pash is sent in the ack
		// // it means -- the message hasn't reached all devices yet
		// // we'll retry sending the message here
		// if(attrs.phash) {
		// 	this.config.logger.info({ attrs }, 'received phash in ack, resending message...')
		// 	const msg = await this.config.getMessage(key)
		// 	if(msg) {
		// 		await this.sock.relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
		// 	} else {
		// 		this.config.logger.warn({ attrs }, 'could not send message again, as it was not found')
		// 	}
		// }

		// error in acknowledgement,
		// device could not display the message
		if (attrs.error) {
			const isReachoutTimelocked = attrs.error === String(NACK_REASONS.SenderReachoutTimelocked)

			if (attrs.error === SERVER_ERROR_CODES.MessageAccountRestriction) {
				// 463 = 1:1 message missing privacy token (tctoken). Usually means the
				// account is restricted: WhatsApp blocks starting new chats but preserves
				// existing ones, since established chats already carry a tctoken.
				// WA Web prevents this client-side (disables the compose bar).
				// No retry — retrying counts as another "reach out" and worsens the restriction.
				this.config.logger.warn(
					{ msgId: attrs.id, from: attrs.from },
					'error 463: account restricted or missing tctoken for contact'
				)

				const ackFrom = attrs.from
				if (ackFrom && !this.inFlight463Recoveries.has(ackFrom)) {
					this.inFlight463Recoveries.add(ackFrom)
					void (async () => {
						try {
							const getPNForLID = this.sock.signalRepository.lidMapping.getPNForLID.bind(
								this.sock.signalRepository.lidMapping
							)
							const tcStorageJid = await resolveTcTokenJid(ackFrom, this.getLIDForPN)
							const issueJid = await resolveIssuanceJid(
								ackFrom,
								this.sock.serverProps.lidTrustedTokenIssueToLid,
								this.getLIDForPN,
								getPNForLID
							)
							const result = await this.sock.issuePrivacyTokens([issueJid], unixTimestampSeconds())
							await storeTcTokensFromIqResult({
								result,
								fallbackJid: tcStorageJid,
								keys: this.sock.authState.keys,
								getLIDForPN: this.getLIDForPN,
								onNewJidStored: this.trackTcTokenJid
							})
							this.config.logger.debug({ from: ackFrom }, 'completed 463 token recovery issuance')
						} catch (err: any) {
							this.config.logger.debug({ from: ackFrom, err: err?.message }, 'failed 463 token recovery issuance')
						} finally {
							this.inFlight463Recoveries.delete(ackFrom)
						}
					})()
				}
			} else if (attrs.error === SERVER_ERROR_CODES.SmaxInvalid) {
				this.config.logger.warn(
					{ msgId: attrs.id, from: attrs.from },
					'smax-invalid (479): stanza rejected by server — likely stale device session or malformed addressing'
				)
			} else if (isReachoutTimelocked) {
				// user is temporarily restricted, fetch current restriction details
				await this.sock
					.fetchAccountReachoutTimelock()
					.catch(err => this.config.logger.warn({ err }, 'failed to fetch reachout timelock'))
				this.config.logger.warn({ attrs }, 'received error in ack')
			} else {
				this.config.logger.warn({ attrs }, 'received error in ack')
			}

			this.sock.ev.emit('messages.update', [
				{
					key,
					update: {
						status: WAMessageStatus.ERROR,
						messageStubParameters: isReachoutTimelocked ? [attrs.error, ACCOUNT_RESTRICTED_TEXT] : [attrs.error]
					}
				}
			])
		}

		if (attrs.refresh_lid === 'true') {
			this.config.logger.info({ attrs }, 'received refresh_lid in ack, invalidating session and lid mappings')
			const ackFrom = attrs.from
			if (ackFrom) {
				const getLIDForPN = this.sock.signalRepository.lidMapping.getLIDForPN.bind(
					this.sock.signalRepository.lidMapping
				)
				const oldLid = await this.getLIDForPN(ackFrom)

				// clear signal session to force redistribution of keys
				await this.sock.authState.keys.set({
					session: { [ackFrom]: null },
					'sender-key-memory': { [ackFrom]: null }
				})

				if (oldLid) {
					await this.sock.authState.keys.set({
						session: { [oldLid]: null },
						'sender-key-memory': { [oldLid]: null }
					})
				}

				this.sock.ev.emit('lid-migration.update', {
					pn: ackFrom,
					oldLid: oldLid || undefined,
					reason: 'ack-refresh-lid',
					messageId: attrs.id
				})
			}
		}
	}

	/// processes a node with the given function
	/// and adds the task to the existing buffer if we're buffering events
	public processNodeWithBuffer = async <T>(
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode, offline: boolean) => Promise<T>
	) => {
		const execTask = () => {
			return exec(node, false).catch(err => this.sock.onUnexpectedError(err, identifier))
		}

		this.sock.ev.buffer()
		await execTask()
		this.sock.ev.flush()
	}

	public processNode = async (
		type: MessageType,
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode) => Promise<void>
	) => {
		// Fast path: ack and drop ignored JIDs before entering the buffer/queue
		const from = node.attrs.from
		let ignoreJid = from
		if (type === 'receipt' && from) {
			const attrs = node.attrs
			const isLid = attrs.from!.includes('lid')
			const isNodeFromMe = areJidsSameUser(
				attrs.participant || attrs.from,
				isLid ? this.sock.authState.creds.me?.lid : this.sock.authState.creds.me?.id
			)
			ignoreJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		}

		if (ignoreJid && ignoreJid !== S_WHATSAPP_NET && this.config.shouldIgnoreJid(ignoreJid)) {
			await this.sendMessageAck(node, type === 'message' ? NACK_REASONS.UnhandledError : undefined)
			return
		}

		const isOffline = !!node.attrs.offline

		if (isOffline) {
			this.offlineNodeProcessor.enqueue(type, node)
		} else {
			await this.processNodeWithBuffer(node, identifier, exec)
		}
	}

	public pruneExpiredTcTokens = async () => {
		try {
			await this.tcTokenIndexLoaded

			// Union with the persisted index picks up JIDs added by other layers
			// (history sync) without needing inter-module wiring.
			const persisted = await readTcTokenIndex(this.sock.authState.keys)
			const allJids = new Set<string>(this.tcTokenKnownJids)
			for (const jid of persisted) allJids.add(jid)
			if (!allJids.size) return

			const jids = [...allJids]
			const allTokens = await this.sock.authState.keys.get('tctoken', jids)

			type TcTokenWriteValue = null | { token: Buffer; timestamp?: string; senderTimestamp?: number }
			const writes: { [jid: string]: TcTokenWriteValue } = {}
			const survivors = new Set<string>()
			let mutated = 0

			for (const jid of jids) {
				const entry = allTokens[jid]
				if (!entry) {
					// Tracked but nothing in store — drop from index.
					mutated++
					continue
				}

				const hasPeerToken = !!entry.token?.length
				const peerTokenExpired = hasPeerToken && isTcTokenExpired(entry.timestamp)
				const hasSenderTs = entry.senderTimestamp !== undefined
				const senderTsExpired = hasSenderTs && isTcTokenExpired(entry.senderTimestamp)
				const keepPeerToken = hasPeerToken && !peerTokenExpired
				const keepSenderTs = hasSenderTs && !senderTsExpired

				if (!keepPeerToken && !keepSenderTs) {
					writes[jid] = null
					mutated++
				} else if (peerTokenExpired && keepSenderTs) {
					writes[jid] = { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp }
					survivors.add(jid)
					mutated++
				} else {
					survivors.add(jid)
				}
			}

			if (mutated === 0) return

			await this.sock.authState.keys.set({
				tctoken: {
					...writes,
					[TC_TOKEN_INDEX_KEY]: {
						token: Buffer.from(JSON.stringify([...survivors]))
					}
				}
			})

			this.tcTokenKnownJids.clear()
			for (const jid of survivors) this.tcTokenKnownJids.add(jid)

			this.config.logger.debug({ mutated, remaining: survivors.size }, 'pruned expired tctokens')
		} catch (err: any) {
			this.config.logger.warn({ err: err?.message }, 'failed to prune expired tctokens')
		}
	}
}

export const makeMessagesRecvSocket = (config: SocketConfig) => {
	const sock = makeMessagesSocket(config)
	const handler = new MessagesRecvHandler(sock, config)

	// recv a message
	sock.ws.on('CB:message', async (node: BinaryNode) => {
		await handler.processNode('message', node, 'processing message', handler.handleMessage.bind(handler))
	})

	sock.ws.on('CB:call', async (node: BinaryNode) => {
		await handler.processNode('call', node, 'handling call', handler.handleCall.bind(handler))
	})

	sock.ws.on('CB:receipt', async node => {
		await handler.processNode('receipt', node, 'handling receipt', handler.handleReceipt.bind(handler))
	})

	sock.ws.on('CB:notification', async (node: BinaryNode) => {
		await handler.processNode('notification', node, 'handling notification', handler.handleNotification.bind(handler))
	})
	sock.ws.on('CB:ack,class:message', (node: BinaryNode) => {
		handler.handleBadAck(node).catch(error => sock.onUnexpectedError(error, 'handling bad ack'))
	})

	sock.ev.on('call', async ([call]) => {
		if (!call) {
			return
		}

		// missed call + group call notification message generation
		if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
			const msg: WAMessage = {
				key: {
					remoteJid: call.chatId,
					id: call.id,
					fromMe: false
				},
				messageTimestamp: unixTimestampSeconds(call.date)
			}
			if (call.status === 'timeout') {
				if (call.isGroup) {
					msg.messageStubType = call.isVideo
						? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
						: WAMessageStubType.CALL_MISSED_GROUP_VOICE
				} else {
					msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE
				}
			} else {
				msg.message = { call: { callKey: Buffer.from(call.id) } }
			}

			const protoMsg = proto.WebMessageInfo.fromObject(msg) as WAMessage
			await sock.upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
		}
	})

	sock.ev.on('connection.update', ({ isOnline, connection }) => {
		if (typeof isOnline !== 'undefined') {
			handler.sendActiveReceipts = isOnline
			config.logger.trace(`sendActiveReceipts set to "${handler.sendActiveReceipts}"`)
		}

		// Flush pending tctoken index save on disconnect to avoid writing after close
		if (connection === 'close' && handler.tcTokenIndexTimer) {
			clearTimeout(handler.tcTokenIndexTimer)
			handler.tcTokenIndexTimer = undefined
			// Best-effort flush — may fail if store is already closed
			try {
				void Promise.resolve(handler.flushTcTokenIndex()).catch(() => {})
			} catch {
				/* ignore sync errors */
			}
		}

		// Prune expired tctokens when coming online, at most once per 24 hours
		if (isOnline) {
			const now = Date.now()
			const DAY_MS = 24 * 60 * 60 * 1000
			if (now - handler.lastTcTokenPruneTs >= DAY_MS) {
				handler.lastTcTokenPruneTs = now
				void handler.pruneExpiredTcTokens()
			}
		}
	})

	sock.registerSocketEndHandler(() => {
		if (!config.msgRetryCounterCache && handler.msgRetryCache.close) {
			handler.msgRetryCache.close()
		}

		if (!config.callOfferCache && handler.callOfferCache.close) {
			handler.callOfferCache.close()
		}

		handler.identityAssertDebounce.close()
		handler.sendActiveReceipts = false
	})

	return {
		...sock,
		sendMessageAck: handler.sendMessageAck.bind(handler),
		sendRetryRequest: handler.sendRetryRequest.bind(handler),
		rejectCall: handler.rejectCall.bind(handler),
		fetchMessageHistory: handler.fetchMessageHistory.bind(handler),
		requestPlaceholderResend: handler.requestPlaceholderResend.bind(handler),
		messageRetryManager: sock.messageRetryManager
	}
}
