<h1 align='center'><img alt="Baileys logo" src="https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/Media/logo.png" height="75"/></h1>

<div align='center'><b>Baileys Enterprise Fork (Baileys-next)</b> es un framework de Alto Nivel basado en la librería original de WebSockets para WhatsApp Web.</div>

---

## 🚀 ¿Por qué usar este Fork? (Baileys-next)

Este proyecto nace como una evolución de la librería original de Baileys para resolver los problemas críticos que enfrentan los desarrolladores al crear bots de producción masivos: **fugas de memoria (RAM), caídas por desconexión, dificultad para manejar multimedia y la complejidad de los Eventos puros**.

1. **Framework Orientado a Objetos (DX):** Adiós a los callbacks anidados y al código espagueti. Introduce la clase `Bot` y un sistema de **Middlewares**, haciendo que responder a un mensaje sea tan simple como: `ctx.reply('Hola')`.
2. **Escalabilidad (Cero pérdida de RAM):** El Baileys original guarda el historial de chats en memoria (RAM), lo cual crashea servidores rápidamente. Este fork usa un motor nativo en **SQLite** de alta velocidad (`better-sqlite3`), escribiendo y leyendo los estados directamente en disco con 0.05ms de latencia.
3. **Resiliencia Extrema:** Sistema inyectado de **Exponential Backoff** y Cola de Mensajes (`MessageQueue`). Si tu internet parpadea o se cae, el bot no se rompe ni pierde comandos; los encola y los dispara cuando vuelve la red.
4. **Gestor Multimedia Automágico:** ¡Olvídate de instalar FFmpeg en tu sistema operativo! El fork descarga `ffmpeg-static` automáticamente. Convierte videos a stickers (`ctx.replySticker()`) o MP3s a Notas de Voz nativas (`ctx.replyVoiceNote()`) en una sola línea de código, añadiendo tus metadatos y autoría en el archivo.
5. **Analíticas y Fantasmas (StatsManager):** Base de datos silenciosa que rastrea quiénes son los más activos de tu grupo, los stickers más usados y expone métodos como `bot.stats.getGhosts(groupId)` para encontrar a los miembros que nunca participan.

---

## 💻 Instalación

Este fork ya incluye todas las dependencias necesarias (`better-sqlite3`, `fluent-ffmpeg`, `node-webpmux`, etc.) pre-configuradas.

```bash
yarn add github:LuferOS/Baileys-next
```
*(Nota: Se recomienda usar Node.js v20 LTS o v22 LTS para que la compilación de la base de datos sea ultra-rápida).*

---

## 🛠️ Guía Rápida de Uso

El poder de este fork radica en su nueva sintaxis limpia:

```typescript
import { Bot, useMultiFileAuthState } from '@whiskeysockets/baileys'

async function startBot() {
    // 1. Cargamos la sesión (igual que siempre)
    const { state, saveCreds } = await useMultiFileAuthState('sesion')

    // 2. Instanciamos el Bot (inicia automáticamente SQLite, la Cola y las Analíticas)
    const bot = new Bot({ 
        auth: state, 
        printQRInTerminal: true,
        enableStats: true // Activar rastreo de fantasmas
    })

    // 3. Crear Comandos Mágicos
    bot.command('!fantasmas', async (ctx) => {
        const fantasmas = bot.stats.getGhosts(ctx.remoteJid, 30) // Inactivos hace 30 días
        await ctx.reply(`Encontré ${fantasmas.length} fantasmas en este grupo.`)
    })
    
    bot.command('!sticker', async (ctx) => {
        // Asumiendo que obtuviste un buffer multimedia
        await ctx.replySticker(buffer, { packname: 'SuperBot', author: '@luis' })
    })

    // 4. Guardar credenciales y encender
    bot.socket?.ev.on('creds.update', saveCreds)
    await bot.start()
}

startBot()
```

### Acceso a Bajo Nivel
Si en algún momento necesitas hacer llamadas crudas a la API original de Baileys, la instancia completa de `makeWASocket` está disponible a través de `bot.socket`. ¡No pierdes nada, solo ganas superpoderes!

---

## 💖 Créditos y Reconocimientos

Este proyecto (`Baileys-next`) es un **Fork** construido sobre los hombros de gigantes. Todo el mérito de la ingeniería de red (Noise Protocol, WebSockets y criptografía) pertenece a la comunidad original:

* **WhiskeySockets / Rajeh:** Creadores y mantenedores principales actuales del core original de la librería.
* **@pokearaujo:** Por escribir y compartir sus observaciones críticas sobre el funcionamiento interno de WhatsApp Multi-Device.
* **@Sigalor:** Por su investigación temprana y la ingeniería inversa del protocolo original de WhatsApp Web.
* **@Rhymen:** Por la primera implementación en el lenguaje Go, que sirvió como inspiración fundamental.

Si tu empresa depende del núcleo de Baileys y deseas apoyar financieramente al mantenedor original del motor base (Rajeh), puedes hacerlo en su [Sponsor Page](https://purpshell.dev/sponsor).

---

## ⚖️ Aviso Legal (Disclaimer)

*Este proyecto NO está afiliado, asociado, autorizado, respaldado por, ni conectado de ninguna manera oficial con WhatsApp o cualquiera de sus filiales. "WhatsApp" y las marcas relacionadas son marcas registradas de sus respectivos dueños.*

*Los mantenedores de este Fork no aprueban en modo alguno el uso de esta aplicación en prácticas que violen los Términos de Servicio de WhatsApp (tales como spam, mensajería masiva automatizada no deseada o extracción de datos sin consentimiento). Se apela a la responsabilidad personal de sus usuarios para usar esta librería de forma ética y legítima.*
