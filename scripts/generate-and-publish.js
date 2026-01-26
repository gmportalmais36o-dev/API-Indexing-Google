import fs from "fs";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { parseString } from "xml2js";

const SITEMAP_URL = "https://portalmais360.com.br/storage/sitemap/posts.xml";
const INDEXNOW_API = "https://api.indexnow.org/indexnow";
const LAST_SENT_FILE = ".last_sent.json";
const MAX_URLS_PER_RUN = 10;

// Configurações do IndexNow
const INDEXNOW_HOST = "portalmais360.com.br";
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || "sua-chave-indexnow";

// 🧩 Carregar última URL enviada
function loadLastSent() {
  try {
    const data = fs.readFileSync(LAST_SENT_FILE, "utf8");
    const parsed = JSON.parse(data);
    return parsed.lastSentUrl || null;
  } catch {
    console.log("⚠️ Nenhum histórico anterior encontrado (primeira execução).");
    return null;
  }
}

// 💾 Salvar última URL enviada
function saveLastSent(url) {
  const payload = {
    lastUpdated: new Date().toISOString(),
    lastSentUrl: url
  };
  fs.writeFileSync(LAST_SENT_FILE, JSON.stringify(payload, null, 2));
}

// 🔐 Autenticar com a Google Indexing API
async function getAuthClient() {
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GSA_CLIENT_EMAIL,
      private_key: process.env.GSA_PRIVATE_KEY.replace(/\\n/g, "\n")
    },
    scopes: ["https://www.googleapis.com/auth/indexing"]
  });
  return await auth.getClient();
}

// 📬 Enviar URL para o Google Indexing
async function publishToGoogle(url, client) {
  try {
    await client.request({
      url: "https://indexing.googleapis.com/v3/urlNotifications:publish",
      method: "POST",
      data: { url, type: "URL_UPDATED" }
    });
    console.log(`✅ Enviado para indexação: ${url}`);
  } catch (error) {
    const code = error.response?.status;
    if (code === 429) {
      console.warn("⚠️ Limite de requisições atingido (429). Interrompendo envios.");
      throw new Error("429_LIMIT");
    } else {
      console.error(`❌ Erro ao enviar ${url}:`, error.response?.data || error.message);
    }
  }
}

// 🔍 Enviar URLs para IndexNow
async function publishToIndexNow(urlList) {
  try {
    const payload = {
      host: INDEXNOW_HOST,
      key: INDEXNOW_KEY,
      urlList: urlList
    };

    const response = await axios.post(INDEXNOW_API, payload, {
      headers: { "Content-Type": "application/json" }
    });

    if (response.status === 200) {
      console.log(`✅ IndexNow: ${urlList.length} URL(s) enviada(s) com sucesso`);
    } else {
      console.warn(`⚠️ IndexNow: Resposta inesperada (${response.status})`);
    }
  } catch (error) {
    const code = error.response?.status;
    if (code === 429) {
      console.warn("⚠️ IndexNow: Limite de requisições atingido (429).");
      throw new Error("429_LIMIT_INDEXNOW");
    } else if (code === 400) {
      console.error("❌ IndexNow: Erro 400 - Verifique o host, key ou formato das URLs");
      console.error("   Resposta:", error.response?.data);
    } else {
      console.error(`❌ IndexNow: Erro ${code}`, error.response?.data || error.message);
    }
  }
}

// 📥 Buscar e parsear sitemap XML
async function fetchSitemapUrls() {
  try {
    const response = await axios.get(SITEMAP_URL);
    const xmlData = response.data;

    return new Promise((resolve, reject) => {
      parseString(xmlData, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        // Extrair URLs do sitemap (formato padrão: urlset > url > loc)
        const urls = result.urlset?.url?.map(entry => entry.loc[0]) || [];
        resolve(urls);
      });
    });
  } catch (error) {
    console.error("❌ Erro ao buscar sitemap:", error.message);
    throw error;
  }
}

// 🔔 Pingar Sitemap (opcional, mas recomendado)
async function pingSitemap() {
  try {
    const pingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`;
    await axios.get(pingUrl);
    console.log(`🔔 Sitemap pingado com sucesso no Google`);
  } catch (err) {
    console.warn("⚠️ Falha ao pingar sitemap:", err.message);
  }
}

// 🧠 Função principal
async function main() {
  console.log("🚀 Iniciando processo de Indexação via Sitemap...");

  // Buscar URLs do sitemap
  const urls = await fetchSitemapUrls();

  if (urls.length === 0) {
    console.log("⚠️ Nenhuma URL encontrada no sitemap.");
    return;
  }

  console.log(`📊 Total de URLs no sitemap: ${urls.length}`);

  const lastSentUrl = loadLastSent();
  console.log("🗂 Última URL enviada:", lastSentUrl || "nenhuma ainda");

  let newUrls = [];

  // 🔎 Captura todas as URLs até encontrar a última enviada
  if (lastSentUrl) {
    for (const url of urls) {
      if (url === lastSentUrl) break;
      newUrls.push(url);
    }
  } else {
    // Primeira execução: envia só as 5 mais recentes
    newUrls = urls.slice(0, 5);
  }

  if (newUrls.length === 0) {
    console.log("🟡 Nenhuma nova URL para enviar.");
    return;
  }

  // Garante limite por execução
  newUrls = newUrls.slice(0, MAX_URLS_PER_RUN);
  console.log(`📡 Enviando ${newUrls.length} novas URLs para o Google...`);

  const client = await getAuthClient();

  let successCount = 0;

  try {
    for (const url of newUrls) {
      await publishToGoogle(url, client);
      successCount++;
    }
  } catch (err) {
    if (err.message === "429_LIMIT") {
      console.log("⚠️ Execução interrompida por limite de API. URLs restantes serão enviadas depois.");
    } else {
      console.error("❌ Erro inesperado:", err);
    }
  }

  // 📤 Enviar para IndexNow (todas as URLs mesmo que Google tenha falhado)
  try {
    await publishToIndexNow(newUrls);
  } catch (err) {
    if (err.message !== "429_LIMIT_INDEXNOW") {
      console.error("❌ Erro ao enviar para IndexNow");
    }
  }

  // 💾 Salva apenas a última URL que foi REALMENTE enviada com sucesso
  if (successCount > 0) {
    saveLastSent(newUrls[0]);
    console.log(`💾 Última URL enviada salva: ${newUrls[0]}`);
  }

  await pingSitemap();

  console.log("✅ Processo concluído com sucesso!");
}

main().catch(err => {
  console.error("❌ Erro fatal:", err);
  process.exit(1);
});
