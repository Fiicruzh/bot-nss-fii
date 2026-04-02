require("dotenv").config()
process.on("uncaughtException", console.error)
process.on("unhandledRejection", console.error)

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys")

const P = require("pino")
const axios = require("axios")
const fs = require("fs-extra")
const path = require("path")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("ffmpeg-static")
const sharp = require("sharp")

ffmpeg.setFfmpegPath(ffmpegPath)

const PHONE_NUMBER = process.env.PHONE_NUMBER || "6287886582175"
const API_KEY = process.env.GROQ_API_KEY || "GANTI_API_KEY"

if(!PHONE_NUMBER || !API_KEY){
    console.log("❌ ENV belum lengkap")
    process.exit()
}

/* ================= DATABASE ================= */
let welcomeGroups = new Set()
let antilinkGroups = new Set()
let undanganGroups = {}
const memory = {}
const aiMode = {}
const spam = {}
const bannedMembers = {} // menampung member yang di-kick agar tidak bisa masuk lagi

let pairingPrinted = false
let pairingCodeRequested = false

/* ================= HELPERS ================= */

async function getBuffer(message, type){
    const stream = await downloadContentFromMessage(message,type)
    let buffer = Buffer.from([])
    for await(const chunk of stream){
        buffer = Buffer.concat([buffer, chunk])
    }
    return buffer
}

async function bufferFromStream(stream){
    let buffer = Buffer.from([])
    for await(const chunk of stream){
        buffer = Buffer.concat([buffer, chunk])
    }
    return buffer
}

async function toWebp(buffer){
    try{
        return await sharp(buffer)
        .resize(512,512,{fit:"cover"})
        .webp()
        .toBuffer()
    }catch{
        return null
    }
}

async function askAI(messages){
    try{
        const res = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            { model:"llama-3.3-70b-versatile", messages },
            { headers:{ Authorization:`Bearer ${API_KEY}`, "Content-Type":"application/json" } }
        )
        return res.data.choices[0].message.content
    }catch{
        return "⚠️ AI sedang sibuk"
    }
}

async function textToVoice(text){
    try{
        const res = await axios.get(
            `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(text)}`,
            { responseType:"arraybuffer" }
        )
        return Buffer.from(res.data)
    }catch{
        return null
    }
}

async function textToSticker(text){
    try{
        const res = await axios.get(
            `https://api.memegen.link/images/custom/-/${encodeURIComponent(text)}.png`,
            { responseType:"arraybuffer" }
        )
        const png = Buffer.from(res.data)
        return await toWebp(png)
    }catch{
        return null
    }
}

async function videoToAudio(inputPath,outputPath){
    return new Promise((resolve,reject)=>{
        ffmpeg(inputPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .save(outputPath)
        .on("end",resolve)
        .on("error",reject)
    })
}

/* ================= START BOT ================= */

async function startBot(){
    const { state, saveCreds } = await useMultiFileAuthState("./session")
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level:"silent" }),
        printQRInTerminal:false
    })

    sock.ev.on("creds.update", saveCreds)
    console.log("🚀 Bot WhatsApp Aktif")

    /* ================= CONNECTION ================= */
    sock.ev.on("connection.update", async(update)=>{
        const { connection, qr, lastDisconnect } = update
        if(connection==="connecting") console.log("🔄 Menghubungkan ke WhatsApp...")
        if(connection==="open") console.log("✅ Bot terhubung")
        if(connection==="close"){
            console.log("❌ Koneksi terputus")
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if(shouldReconnect){
                pairingPrinted=false
                pairingCodeRequested=false
                startBot()
            }else{
                fs.removeSync("./session")
            }
        }

        if(qr && !sock.authState.creds.registered && !pairingPrinted){
            pairingPrinted=true
            setTimeout(async()=>{
                try{
                    const code = await sock.requestPairingCode(PHONE_NUMBER)
                    console.log("================================")
                    console.log("PAIRING CODE WHATSAPP")
                    console.log(code)
                    console.log("================================")
                }catch(err){
                    console.log("❌ Gagal pairing:", err)
                    pairingPrinted=false
                }
            },3000)
        }
    })

    /* ================= WELCOME MEMBER & KICK BANNED ================= */
    sock.ev.on("group-participants.update", async(data)=>{
        const groupId = data.id
        const addedUsers = data.participants || []

        // kick banned member otomatis
        if(data.action==="add"){
            for(const participant of addedUsers){
                const userId = typeof participant === "string" ? participant : participant.id
                if(bannedMembers[groupId]?.includes(userId)){
                    await sock.groupParticipantsUpdate(groupId,[userId],"remove")
                }
            }
        }

        // kirim welcome
        if(data.action==="add" && welcomeGroups.has(groupId)){
            for(const participant of addedUsers){
                const userId = typeof participant === "string" ? participant : participant.id
                const user = userId.split("@")[0]
                const text = `
👋 Selamat datang @${user}
˚ ༘♡ ·˚꒰ ᨰׁׅꫀׁׅܻ݊ᥣׁׅ֪ᝯׁ֒ᨵׁׅׅꩇׁׅ֪݊ ꫀׁׅܻ݊ ꒱ ₊˚ˑ༄

*NIGHTFALL SILENT SLAUGHTER*

Nama:
Usn:
Umur:
Asal:
Sudah bisa CN / Belum?
                `
                await sock.sendMessage(groupId,{ text, mentions:[userId] })
            }
        }
    })

    /* ================= MESSAGE ================= */
    sock.ev.on("messages.upsert", async({ messages })=>{
        try{
            const msg = messages[0]
            if(!msg.message) return
            const from = msg.key.remoteJid
            const sender = msg.key.participant || from
            const type = Object.keys(msg.message)[0]
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ""

            /* ================= SPAM ================= */
            if(!spam[sender]) spam[sender]=0
            spam[sender]++
            setTimeout(()=> spam[sender]=0,4000)
            if(spam[sender]>6) return sock.sendMessage(from,{ text:"⚠️ Jangan spam" })

            /* ================= CEK ADMIN ================= */
            let isAdmin=false
            if(from.endsWith("@g.us")){
                const metadata = await sock.groupMetadata(from)
                const admins = metadata.participants.filter(p=>p.admin).map(p=>p.id)
                isAdmin = admins.includes(sender)
            }

            /* ================= MENU ================= */
            if(text===".menu"){
                return sock.sendMessage(from,{
                    image: { url:"https://i.ibb.co.com/9kPHK2pJ/IMG-20260331-WA0079.jpg" },
                    caption: `
☆「 NSSxFii MENU 」

╔┈「 ADMIN MENU 」
╎- 》.setwelcome
╎- 》.setundangan
╎- 》.stopundangan
╎- 》.antilink
╎- 》.kick
╎┈「 MEMBER MENU 」
╎- 》.rules
╚┈┈┈┈┈┈┈┈┈┈┈┈
╔┈「 AI-FII MENU 」
╎- 》.chat → Aktifkan AI
╎- 》.off → Matikan AI
╎- 》.reset → Reset Memory
╚┈┈┈┈┈┈┈┈┈┈┈┈
╔┈「 MENU-FII 」
╎- 》.stiker (gambar + caption)
╎- 》.tts teks
╎- 》.mp3 convert mp4 → mp3
╎- 》.tiktok link
╚┈┈┈┈┈┈┈┈┈┈┈┈
                    `
                })
            }

            /* ================= ADMIN COMMAND ================= */
            if(text===".setwelcome"){
                if(!isAdmin) return sock.sendMessage(from,{ text:"❌ Hanya admin yang bisa pakai command ini" })
                welcomeGroups.add(from)
                return sock.sendMessage(from,{ text:"✅ Welcome diaktifkan" })
            }

            if(text===".rules"){
                return sock.sendMessage(from,{
                    text:`📜 *[ RULES NIGHTFALL SILENT SLAUGHTER ]*
*1. WAJIB 17+*
*2. DILARANG DRAMA SESAMA MEMBER*
*3. DILARANG MEMBUAT KERIBUTAN DALAM STATUS MENYANDANG NAMA CLAN, MAKA AKAN DIKENAKAN SANKSI*
*4. DILARANG MENJELEKKAN SESAMA MEMBER DAN ORG LAIN*
*5. DILARANG KERAS OUT YG DISEBABKAN PACARAN*
*6. HARUS KOMPAK DAN SALING BERBAUR JANGAN DICUEKIN SESAMA MEMBER*
*7. ⁠DILARANG NGETAG GRUP KE STATUS KECUALI TENTANG GAME COLAB ATAUPUN JUALAN*
*8. ⁠WAJIB BISA CN (GANTI NAMA)*
*9. JAGA NAMA BAIK CLAN*
*10. DILARANG KERASS BERMUKA DUAA!!*
*11. ⁠MASUK BAIK BAIK, OUT JUGA HARUS BAIK BAIK DENGAN BILANG DULU KE STAF*
*12. ⁠DILARANG KERAS UNTUK MENANYAKAN YANG MENYANGKUT HAL PRIBADI KE MEMBER LAINNYA*
*13. JAGA SOPAN SANTUN SESAMA MEMBER ATAU PUN STAFF*
*14. YANG SUDAH OUT TIDA BISA JOIN LAGI DENGAN ALASAN APAPUN ITU*
LINK DISCORD : https://discord.gg/JuAq2NBf6
LINK VARCITY : https://www.roblox.com/share?code=4e879bb8c0113d429e2b3381537c0e5f&type=AvatarItemDetails`
                })
            }

            if(text===".antilink"){
                if(!isAdmin) return sock.sendMessage(from,{ text:"❌ Hanya admin yang bisa pakai command ini" })
                antilinkGroups.add(from)
                return sock.sendMessage(from,{ text:"🚫 Anti link aktif" })
            }

            if(antilinkGroups.has(from) && text.includes("https://chat.whatsapp.com")){
                return sock.sendMessage(from,{ text:"🚫 Link grup dilarang!" })
            }

            if(text.startsWith(".kick")){
                if(!isAdmin) return sock.sendMessage(from,{ text:"❌ Hanya admin yang bisa pakai command ini" })
                if(!msg.message.extendedTextMessage) return
                const mentioned = msg.message.extendedTextMessage.contextInfo?.mentionedJid
                if(!mentioned) return
                // tandai sebagai banned
                if(!bannedMembers[from]) bannedMembers[from] = []
                bannedMembers[from].push(...mentioned)
                await sock.groupParticipantsUpdate(from,mentioned,"remove")
            }

            if(text.startsWith(".setundangan")){
                if(!isAdmin) return sock.sendMessage(from,{ text:"❌ Hanya admin yang bisa pakai command ini" })
                const pesan = text.replace(".setundangan","").trim()
                if(!pesan) return sock.sendMessage(from,{ text:"Contoh:\n.setundangan Ayo join clan NIGHTFALL" })
                undanganGroups[from]={ text:pesan, timer:null }
                return sock.sendMessage(from,{ text:"✅ Pesan undangan disimpan\nGunakan .interval untuk memulai" })
            }

            if(text.startsWith(".interval")){
                if(!isAdmin) return sock.sendMessage(from,{ text:"❌ Hanya admin yang bisa pakai command ini" })
                if(!undanganGroups[from]) return sock.sendMessage(from,{ text:"⚠️ Gunakan .setundangan dulu" })
                const waktu = text.split(" ")[1]
                let ms = {"1menit":60000,"2menit":120000,"3menit":180000,"4menit":240000,"5menit":300000,"6menit":360000,"7menit":420000,"8menit":480000,"9menit":540000,"10menit":600000,"30menit":1800000,"1jam":3600000,"2jam":7200000}[waktu]
                if(!ms) return sock.sendMessage(from,{ text:"Gunakan:\n.interval 30menit\n.interval 1jam\n.interval 2jam" })
                if(undanganGroups[from].timer) clearInterval(undanganGroups[from].timer)
                undanganGroups[from].timer = setInterval(async()=>{
                    await sock.sendMessage(from,{ text:undanganGroups[from].text })
                }, ms)
                return sock.sendMessage(from,{ text:`✅ Undangan otomatis aktif setiap ${waktu}` })
            }

            if(text===".stopundangan"){
                if(!isAdmin) return sock.sendMessage(from,{ text:"❌ Hanya admin yang bisa pakai command ini" })
                if(!undanganGroups[from]) return sock.sendMessage(from,{ text:"⚠️ Undangan belum aktif" })
                clearInterval(undanganGroups[from].timer)
                delete undanganGroups[from]
                return sock.sendMessage(from,{ text:"🛑 Undangan otomatis dihentikan" })
            }

            /* ================= AI ================= */
            if(!memory[sender]) memory[sender] = [{ role:"system", content:"Kamu adalah AI WhatsApp santai dan membantu." }]
            if(text===".chat"){ aiMode[sender]=true; return sock.sendMessage(from,{ text:"🤖 AI aktif" }) }
            if(text===".off"){ aiMode[sender]=false; memory[sender]=[]; return sock.sendMessage(from,{ text:"❌ AI mati" }) }
            if(text===".reset"){ memory[sender]=[]; return sock.sendMessage(from,{ text:"🧠 Memory direset" }) }
            if(aiMode[sender] && text){
                memory[sender].push({ role:"user", content:text })
                if(memory[sender].length>20) memory[sender].splice(1,1)
                const reply = await askAI(memory[sender])
                memory[sender].push({ role:"assistant", content:reply })
                return sock.sendMessage(from,{ text:reply })
            }

            /* ================= STICKER ================= */
            if(type === 'imageMessage' && msg.message.imageMessage.caption === '.stiker'){
const buffer = await getBuffer(msg.message.imageMessage,'image')

const input='./stiker.jpg'
const output='./stiker.webp'

fs.writeFileSync(input, buffer)

await new Promise((resolve,reject)=>{
ffmpeg(input)
.outputOptions([
'-vcodec libwebp',
'-vf scale=512:512:force_original_aspect_ratio=decrease,fps=15'
])
.toFormat('webp')
.on('end',resolve)
.on('error',reject)
.save(output)
})

const sticker = fs.readFileSync(output)
await sock.sendMessage(from,{ sticker })

fs.unlinkSync(input)
fs.unlinkSync(output)
}

// versi sharp (script new)
if(msg.message.imageMessage && text === ".stiker"){
const stream = await downloadContentFromMessage(msg.message.imageMessage,"image")
const buffer = await bufferFromStream(stream)

const webp = await toWebp(buffer)

if(!webp){
return sock.sendMessage(from,{ text:"❌ Gagal sticker" })
}

return sock.sendMessage(from,{ sticker:webp })
}

            /* ================= TTS ================= */
            if(text.startsWith('.tts ')){
const query = text.replace('.tts ','')
try{
const url=`https://translate.google.com/translate_tts?ie=UTF-8&tl=id&client=tw-ob&q=${encodeURIComponent(query)}`
const res=await axios.get(url,{
responseType:'arraybuffer',
headers:{'User-Agent':'Mozilla/5.0'}
})
await sock.sendMessage(from,{
audio:res.data,
mimetype:'audio/mp4',
ptt:true
})
}catch{
const audio = await textToVoice(query)
if(audio){
await sock.sendMessage(from,{ audio, mimetype:"audio/mp4" })
}else{
await sock.sendMessage(from,{ text:"❌ TTS gagal" })
}
}
}

            /* ================= VIDEO → MP3 ================= */
            if((type==='videoMessage' && msg.message.videoMessage.caption==='.mp3') || text==='.toaudio'){
                const stream = await downloadContentFromMessage(msg.message.videoMessage,"video")
                const buffer = await bufferFromStream(stream)
                const input = path.join(__dirname,"input.mp4")
                const output = path.join(__dirname,"output.mp3")
                fs.writeFileSync(input, buffer)
                try{
                    await videoToAudio(input,output)
                    const audio = fs.readFileSync(output)
                    await sock.sendMessage(from,{ audio, mimetype:"audio/mpeg" })
                }catch{
                    await sock.sendMessage(from,{ text:"❌ Gagal convert audio" })
                }finally{
                    if(fs.existsSync(input)) fs.unlinkSync(input)
                    if(fs.existsSync(output)) fs.unlinkSync(output)
                }
            }

            /* ================= TIKTOK ================= */
            if(text.startsWith('.tiktok ')){
const url = text.replace('.tiktok ','')

try{
const res = await axios.get(`https://tikwm.com/api/?url=${url}`)
const video = res.data.data.play

const vid = await axios.get(video,{ responseType:'arraybuffer' })

await sock.sendMessage(from,{
video:vid.data,
caption:'✅ TikTok berhasil'
})
}catch{
await sock.sendMessage(from,{ text:'❌ Gagal download TikTok' })
}
}

        }catch(err){ console.log("❌ ERROR:", err) }
    })
}

startBot()