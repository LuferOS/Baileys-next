import { Bot, downloadMediaMessage } from '../src'
import { useMultiFileAuthState } from '../src'

async function startBot() {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')

	const bot = new Bot({
		auth: state,
		printQRInTerminal: true,
		enableStats: true,
		rateLimitMs: 1500,
		autoReadMs: 2000
	})

	// Register creds handler BEFORE start() — this is now safe
	bot.onCreds(saveCreds)

	// Sticker command: convert any image/video to sticker
	bot.command('!sticker', async (ctx) => {
		const msg = ctx.message

		const isMedia = msg.message?.imageMessage || msg.message?.videoMessage
		const isQuotedMedia = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage ||
			msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage

		if (!isMedia && !isQuotedMedia) {
			await ctx.reply({ text: 'Envia una imagen o video con !sticker, o responde a uno.' })
			return
		}

		try {
			await ctx.react('⏳')

			const mediaMessage = isQuotedMedia
				? { message: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage }
				: msg

			const buffer = await downloadMediaMessage(mediaMessage as Parameters<typeof downloadMediaMessage>[0], 'buffer', {})

			await ctx.replySticker(buffer as Buffer, {
				packname: 'MiBot Stickers',
				author: '@luisf'
			})

			await ctx.react('✅')
		} catch (error) {
			console.error('Error creating sticker:', error)
			await ctx.reply({ text: 'Hubo un error convirtiendo el sticker.' })
		}
	})

	// Ping command
	bot.command('!ping', async (ctx) => {
		const start = Date.now()
		await ctx.reply({ text: `Pong! 🏓 (${Date.now() - start}ms)` })
	})

	// Ghost detection command
	bot.command('!fantasmas', async (ctx) => {
		if (!ctx.isGroup || !bot.stats) {
			await ctx.reply({ text: 'Este comando solo funciona en grupos con stats activadas.' })
			return
		}

		const ghosts = await bot.stats.getGhosts(ctx.remoteJid, 30)
		const total = ghosts.filter(g => g.isTotalGhost).length
		const inactive = ghosts.filter(g => !g.isTotalGhost).length

		await ctx.reply({
			text: `👻 Fantasmas del grupo:\n` +
				`- Nunca han hablado: ${total}\n` +
				`- Inactivos (30 dias): ${inactive}\n` +
				`- Total: ${ghosts.length}`
		})
	})

	// Top active users
	bot.command('!top', async (ctx) => {
		if (!ctx.isGroup || !bot.stats) return

		const top = bot.stats.getTopUsers(ctx.remoteJid, 5)
		if (top.length === 0) {
			await ctx.reply({ text: 'Aun no hay estadisticas para este grupo.' })
			return
		}

		const lines = top.map((u, i) => `${i + 1}. @${u.userJid.split('@')[0]} — ${u.messageCount} msgs`)
		await ctx.reply({
			text: `🏆 Top 5 mas activos:\n${lines.join('\n')}`,
			mentions: top.map(u => u.userJid)
		})
	})

	await bot.start()
	console.log('Bot started. Send an image with !sticker to test.')
}

startBot()
