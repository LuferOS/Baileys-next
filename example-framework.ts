import { Bot, Context, SQLiteStore, SessionManager } from './src'

// 1. Initialize a highly performant local store
const store = new SQLiteStore({
    dbPath: './baileys_store.db',
    walMode: true // Write-Ahead Logging for high concurrency
})

// 2. Initialize a Session Manager (to handle multiple users/chats context)
const sessionManager = new SessionManager({
    store: store,
    ttl: 86400 * 7 // Keep sessions for 7 days
})

// 3. Create the Bot Framework Instance
const myBot = new Bot({
    sessionId: 'business-bot-1',
    printQRInTerminal: true, // Auto-print QR for linking
    syncFullHistory: false,  // Skip downloading 5 years of messages to save RAM
    maxQueueSize: 5000,      // Unbounded growth protection for outgoing messages
    store: store,
    sessionManager: sessionManager,
    loggerLevel: 'info',
    usePairingCode: false    // Set to true if you want to link via Phone Number instead of QR
})

// 4. State Management for Web Dashboards (Multi-tenancy / Automation)
myBot.onStateChange((state) => {
    console.log(`[Bot State Changed] ${state.status}`)
    
    if (state.status === 'qr_required') {
        // Send this to your web frontend via WebSockets!
        console.log(`Scan this QR code in your dashboard: ${state.qr}`)
    } else if (state.status === 'online') {
        console.log(`Bot is fully connected and ready!`)
    }
})

// 5. Enterprise Features: Encuestas y Grupos
myBot.onPollVote((vote) => {
    console.log(`[ENCUESTA] El paciente ${vote.sender} votó en "${vote.pollName}"`)
    console.log(`Respuestas seleccionadas:`, vote.selectedOptions)
    // Aquí puedes disparar un POST a tu API web para actualizar la clínica
})

myBot.onGroupParticipantsUpdate((event) => {
    // Ideal para administrar salas médicas o grupos de atención
    if (event.action === 'add') {
        console.log(`[GRUPO] Nuevos miembros añadidos a ${event.id}:`, event.participants)
    } else if (event.action === 'remove') {
        console.log(`[GRUPO] Miembros eliminados de ${event.id}:`, event.participants)
    }
})

// 6. Global Middleware (e.g., Logging, Rate Limiting, Anti-Spam)
myBot.use(async (ctx: Context, next: Function) => {
    const start = Date.now()
    
    // Check user session
    const userState = ctx.session.get<{ strikes: number }>() || { strikes: 0 }
    
    // Example: Drop messages from blocked users
    if (userState.strikes > 5) {
        console.log(`[Blocked] Dropping message from ${ctx.sender}`)
        return 
    }

    // Pass to the next middleware/handler
    await next()

    console.log(`[Processed] Message from ${ctx.sender} in ${Date.now() - start}ms`)
})

// 7. Command Handlers
myBot.command('ping', async (ctx: Context) => {
    // Reply natively and read the message
    await ctx.read()
    await ctx.reply({ text: 'pong!' })
})

myBot.command('encuesta', async (ctx: Context) => {
    // Native rich interactive message (Polls)
    await ctx.replyPoll(
        '¿Cómo calificarías este framework de Baileys?',
        ['⭐⭐⭐⭐⭐ Excelente', '⭐⭐⭐ Bueno', '⭐ Necesita Mejorar'],
        1 // Only allow 1 selection
    )
})

myBot.command('ubicacion', async (ctx: Context) => {
    // Native location sharing
    await ctx.sendLocation(
        19.432608,
        -99.133209,
        'Oficinas Centrales',
        'Zócalo CDMX'
    )
})

myBot.command('stats', async (ctx: Context) => {
    // Fetch stats using the high-performance StatsManager
    if (!myBot.statsManager) return
    const userStats = myBot.statsManager.getUserStats(ctx.sender)
    
    await ctx.reply({
        text: `Tus estadísticas:\n- Mensajes enviados: ${userStats?.messageCount || 0}`
    })
})

// 8. General Message Handler (Catch-All)
myBot.onMessage(async (ctx: Context) => {
    // Skip messages sent by the bot itself
    if (ctx.message.key.fromMe) return

    // Identify Media Types easily
    if (ctx.hasImage) {
        console.log(`Recibida imagen de ${ctx.sender}. Descargando...`)
        try {
            const buffer = await ctx.downloadMedia()
            // Aquí puedes guardarlo usando fs.promises.writeFile('imagen.jpg', buffer)
            // o subirlo directo a tu backend/S3.
            await ctx.reply({ text: '✅ Imagen clínica recibida y guardada.' })
        } catch (err) {
            console.error('Fallo descargando la imagen:', err)
        }
        return
    }

    // Read the text content
    if (ctx.text) {
        console.log(`Mensaje de texto: ${ctx.text}`)
    }
})

// 9. Start the bot
console.log('Starting Baileys Next Framework...')
myBot.start().catch(console.error)

// If you want to log out programmatically from a Web Dashboard:
// await myBot.logout()
