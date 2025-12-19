import express from "express";
import nodemailer from "nodemailer";
import rateLimit from "express-rate-limit";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// ===== GOOGLE SHEETS (FORMA FINAL E CORRETA) =====
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const { google } = require("googleapis");

const rawCreds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!rawCreds) throw new Error("Faltou GOOGLE_SERVICE_ACCOUNT_JSON");

const creds = JSON.parse(rawCreds);

// Render salva \n como texto → corrigimos
const privateKey = creds.private_key.replace(/\\n/g, "\n");

const auth = new google.auth.JWT({
  email: creds.client_email,
  key: privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Pedidos";


  // aceita variações de nome só por segurança
  const clientEmail = creds.client_email || creds.clientEmail;
  let privateKey = creds.private_key || creds.privateKey;

  // 🔴 AQUI está o pulo do gato: se a key vier com \\n, vira \n
  if (typeof privateKey === "string") {
    privateKey = privateKey.replace(/\\n/g, "\n").trim();
  }

  // validações duras (pra não cair no erro do gtoken sem explicar)
  if (!clientEmail) throw new Error("Service Account: faltou client_email no JSON.");
  if (!privateKey) throw new Error("Service Account: faltou private_key no JSON.");
  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("Service Account: private_key não parece uma chave válida (BEGIN PRIVATE KEY ausente).");
  }

  return { clientEmail, privateKey };
}

const { clientEmail, privateKey } = loadServiceAccountFromEnv();

const auth = new google.auth.JWT({
  email: clientEmail,
  key: privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_TAB || "Pedidos";

if (!SPREADSHEET_ID) throw new Error("Faltou GOOGLE_SHEET_ID no Render.");


async function appendPedidoToSheet(pedido) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        pedido.pedidoId,
        pedido.createdAt,
        pedido.destinatario.xNome,
        pedido.destinatario.email,
        pedido.destinatario.fone,
        pedido.enderDest.xMun,
        pedido.enderDest.UF,
        pedido.itens.map(i => `${i.sku} (${i.qtd})`).join(", "),
        pedido.frete || "",
        pedido.obs || ""
      ]]
    }
  });
}



const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Loga todas as requisições (temporário para debug)
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// Health-check
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.use(
  "/api/",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const onlyDigits = (s = "") => String(s).replace(/\D/g, "");
const clean = (s = "") => String(s).trim();

function isCPF(cpf) {
  cpf = onlyDigits(cpf);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === parseInt(cpf[10]);
}

// CNPJ (fixo)
function calcCNPJDigit(base) {
  const w =
    base.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < w.length; i++) sum += parseInt(base[i]) * w[i];
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}
function isCNPJ(cnpj) {
  cnpj = onlyDigits(cnpj);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  const d1 = calcCNPJDigit(cnpj.slice(0, 12));
  const d2 = calcCNPJDigit(cnpj.slice(0, 12) + d1);
  return parseInt(cnpj[12]) === d1 && parseInt(cnpj[13]) === d2;
}

function assert(condition, msg) {
  if (!condition) {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  }
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },

  // evita travar e causar 502
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 10_000,
});

app.post("/api/pedidos", async (req, res) => {
  try {
    const p = req.body || {};

    // --- validações obrigatórias ---
    assert(p.tipoCliente === "PF" || p.tipoCliente === "PJ", "tipoCliente inválido.");
    assert(clean(p.xNome), "xNome obrigatório.");
    assert(clean(p.doc), "doc (CPF/CNPJ) obrigatório.");
    assert(clean(p.email), "email obrigatório.");
    assert(clean(p.fone), "fone/whatsapp obrigatório.");

    assert(p.enderDest && typeof p.enderDest === "object", "enderDest obrigatório.");
    const e = p.enderDest;

    assert(clean(e.CEP), "CEP obrigatório.");
    assert(clean(e.xLgr), "Logradouro obrigatório.");
    assert(clean(e.nro), "Número obrigatório.");
    assert(clean(e.xBairro), "Bairro obrigatório.");
    assert(clean(e.xMun), "Cidade (xMun) obrigatória.");
    assert(clean(e.UF), "UF obrigatória.");

    assert(Array.isArray(p.itens) && p.itens.length > 0, "itens[] obrigatório (mín. 1 item).");

    // --- valida documento ---
    if (p.tipoCliente === "PF") {
      assert(isCPF(p.doc), "CPF inválido.");
    } else {
      assert(isCNPJ(p.doc), "CNPJ inválido.");
    }

    // --- indIEDest e IE ---
    const ind = String(p.indIEDest || "").trim();
    assert(["1", "2", "9"].includes(ind), "indIEDest deve ser 1, 2 ou 9.");
    if (ind === "1") assert(clean(p.IE), "IE obrigatória quando indIEDest=1 (contribuinte ICMS).");

    // --- valida itens ---
    const itens = p.itens.map((it, idx) => {
      assert(it && typeof it === "object", `Item #${idx + 1}: inválido.`);
      const sku = clean(it.sku);
      const qtd = Number(it.qtd);
      assert(sku, `Item #${idx + 1}: sku obrigatório.`);
      assert(Number.isFinite(qtd) && qtd > 0, `Item #${idx + 1}: qtd inválida.`);
      return { sku, qtd, variacao: clean(it.variacao || "") };
    });

    const pedidoId = crypto.randomUUID();

    const pedido = {
      pedidoId,
      createdAt: new Date().toISOString(),
      origem: { UF: "RJ", municipio: "Saquarema" },
      destinatario: {
        tipoCliente: p.tipoCliente,
        xNome: clean(p.xNome),
        CPF: p.tipoCliente === "PF" ? onlyDigits(p.doc) : undefined,
        CNPJ: p.tipoCliente === "PJ" ? onlyDigits(p.doc) : undefined,
        indIEDest: ind,
        IE: clean(p.IE || "") || undefined,
        email: clean(p.email),
        fone: clean(p.fone),
      },     

      enderDest: {
        CEP: onlyDigits(e.CEP),
        xLgr: clean(e.xLgr),
        nro: clean(e.nro),
        xCpl: clean(e.xCpl || ""),
        xBairro: clean(e.xBairro),
        xMun: clean(e.xMun),
        UF: clean(e.UF).toUpperCase(),
      },
      itens,
      frete: clean(p.frete || ""),
      obs: clean(p.obs || ""),
    };

     await appendPedidoToSheet(pedido);

    // backup em arquivo
    await fs.mkdir("./data", { recursive: true });
    const filePath = path.join("data", `pedido-${pedidoId}.json`);
    await fs.writeFile(filePath, JSON.stringify(pedido, null, 2), "utf8");

    // monta e-mail
    const subject = `NOVO PEDIDO ${pedidoId} - ${pedido.enderDest.UF} - ${pedido.destinatario.xNome}`;

    const itensTxt = itens
      .map((it) => `- SKU: ${it.sku} | Qtd: ${it.qtd}${it.variacao ? ` | Var: ${it.variacao}` : ""}`)
      .join("\n");

    const text =
`NOVO PEDIDO
ID: ${pedidoId}
Data: ${pedido.createdAt}

DESTINATÁRIO
- Tipo: ${pedido.destinatario.tipoCliente}
- Nome/Razão: ${pedido.destinatario.xNome}
- CPF/CNPJ: ${p.doc}
- indIEDest: ${pedido.destinatario.indIEDest}
- IE: ${pedido.destinatario.IE || "-"}
- E-mail: ${pedido.destinatario.email}
- WhatsApp: ${pedido.destinatario.fone}

ENDEREÇO
${pedido.enderDest.xLgr}, ${pedido.enderDest.nro}${pedido.enderDest.xCpl ? " - " + pedido.enderDest.xCpl : ""}
Bairro: ${pedido.enderDest.xBairro}
${pedido.enderDest.xMun}/${pedido.enderDest.UF} - CEP ${pedido.enderDest.CEP}

ITENS
${itensTxt}

FRETE: ${pedido.frete || "-"}
OBS: ${pedido.obs || "-"}
`;

    // ✅ RESPONDE IMEDIATAMENTE (não trava)
    res.status(200).json({ ok: true, pedidoId });

    // ✅ envia e-mail em segundo plano (se falhar, não quebra o pedido)
    setImmediate(async () => {
      try {
        await transporter.sendMail({
          from: process.env.MAIL_FROM,
          to: process.env.MAIL_TO,
          replyTo: pedido.destinatario.email,
          subject,
          text,
          attachments: [
            {
              filename: `pedido-${pedidoId}.json`,
              content: JSON.stringify(pedido, null, 2),
              contentType: "application/json",
            },
          ],
        });
        console.log(`[MAIL] enviado pedido ${pedidoId}`);
      } catch (err) {
        console.error("[MAIL] erro ao enviar:", err?.message || err);
      }
    });

    return;
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).send(err.message || "Erro interno.");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando.");
});






























