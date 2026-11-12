// =====================================================================
//  ESTOQUE CUBAS — Apps Script v3 (mesma base do Estoque MKT, sem Upseller/TF)
//  Ajuste em massa seguro (lote único, nunca grava 2x) + backups/restauração
//  + login e presença (quem está usando o site agora)
//  Cole TUDO no Apps Script da planilha ESTOQUE CUBAS (Extensões → Apps Script).
//  Depois: Implantar → Nova implantação → App da Web (ver apps-script-instrucoes.md)
// =====================================================================

// ===== CONFIG =====
var CUBAS_ABA_NOME = "ESTOQUE CUBAS";  // aba do estoque (procurada pelo nome)
var GID_SITE_BAIXA = 355584731;        // e, se o nome mudar, pelo gid
var CUBAS_LOG_NOME = "LOG DE AJUSTES"; // aba do histórico (já criada por você)
var MKT_VERSION = 3;
// Colunas: localizadas pelo cabeçalho (COD. / TOTAL UN / ATUALIZACAO).
// Se não achar o cabeçalho, usa A, C e H, como no Estoque MKT.
var MKT_COL_COD = 1;            // A
var MKT_COL_TOTAL = 3;          // C = TOTAL UN
var MKT_COL_ATUAL = 8;          // H = ATUALIZACAO
var MKT_WIDTH = 8;              // quantas colunas ler
var MKT_BK_SHEET = "_BACKUPS_CUBAS";   // aba oculta com os backups
var MKT_MAX_BACKUPS = 200;
var MKT_CHUNK = 40000;          // caracteres por célula (limite Google = 50.000)

// Logins do site (os mesmos do Estoque MKT): guardam só o HASH da senha.
// Para criar ou trocar uma senha: edite usuário/senha em mktGerarHash (fim do
// arquivo), execute essa função, copie o hash do log e cole aqui.
var MKT_USERS = {
  user64: "6a20f69d631cbf241ca94c66c15c31886a4e41575630d42d03148dee094a5ac5",
  adm: "b3993d5984f5f4b9745543e36ddef81d8b02d9e0c5266f51e3d250d5d7b83cea",
  Silvia: "99b220a978cb77c52940e97b7cd2fe4aeaf01b7a82b57fe90a94a5989f86d7cf",
  Givaldo: "03c136766e7acc351a34ab94d8a6b44da81c3d61d85cd27eb837d3d0b89673d8",
  userFL: "c386678ae65400b335a23841f2ffbd2fd43a9bea55a639e97acd4a49f6037d2e",
  userDF: "8ad508659e8ed199412f58c124eb14cf1ed9513c3a4450c57d4345b955a83989"
};
var MKT_PRES_KEY = "mktPresence"; // chave do cache com as sessões abertas
var MKT_PRES_TTL = 90000;         // ms sem sinal até a sessão sair da lista

// ===== ENTRADAS DO WEB APP =====

// GET → status de lote, lista de backups
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === "ping") return pctJson_({ ok: true, version: MKT_VERSION });
    if (p.action === "status") return pctJson_(mktBatchStatus_(p.batch));
    if (p.action === "listBackups") return pctJson_({ ok: true, backups: mktListBackups_() });
    // plano B: o site manda o lote por GET se o POST falhar
    if (p.action === "post" && p.payload) return pctJson_(mktHandle_(JSON.parse(p.payload)));
    return pctJson_({ ok: false, error: "acao desconhecida (GET)" });
  } catch (err) {
    return pctJson_({ ok: false, error: mktErr_(err) });
  }
}

// POST → login, presença, ajuste em massa, backup, restauração
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error("POST sem conteudo");
    var data = JSON.parse(e.postData.contents);
    return pctJson_(mktHandle_(data));
  } catch (err) {
    return pctJson_({ ok: false, error: mktErr_(err) });
  }
}

function mktHandle_(data) {
  var a = data.action || (data.changes ? "legacy" : "");
  if (a === "login") return mktLogin_(data);
  if (a === "presence") return mktPresence_(data);
  if (a === "listBackups") return { ok: true, backups: mktListBackups_() };
  if (a === "status") return mktBatchStatus_(data.batch);
  // daqui para baixo tudo grava na planilha: exige login
  if (!mktUserOf_(data.token)) throw new Error("sessao expirada: entre de novo");
  if (a === "apply") return mktWithLock_(function () { return mktApplyBatch_(data); });
  if (a === "legacy") return mktWithLock_(function () { return mktApplyLegacy_(data); });
  if (a === "backup") return mktWithLock_(function () {
    return { ok: true, backup: mktCreateBackup_("manual", data.note || "Backup manual", "", null) };
  });
  if (a === "restore") return mktWithLock_(function () { return mktRestore_(data.id, data.scope === "lote"); });
  throw new Error("acao desconhecida: " + a);
}

// ===== LOGIN =====

function mktSha_(txt) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, txt, Utilities.Charset.UTF_8), hex = "";
  for (var i = 0; i < b.length; i++) hex += ("0" + (b[i] & 255).toString(16)).slice(-2);
  return hex;
}
function mktPassHash_(user, pass) { return mktSha_("estoque-mkt|" + user + "|" + pass); }

// Segredo gerado na primeira execução; fica só nas propriedades do script.
function mktSecret_() {
  var pr = PropertiesService.getScriptProperties(), s = pr.getProperty("mktSecret");
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); pr.setProperty("mktSecret", s); }
  return s;
}
// Trocar a senha invalida o token de quem já estava conectado com ela.
function mktToken_(user) { return user + "." + mktSha_(mktSecret_() + "|" + user + "|" + MKT_USERS[user]); }

function mktUserOf_(token) {
  var user = String(token || "").split(".")[0];
  if (!user || !MKT_USERS.hasOwnProperty(user)) return null;
  return mktToken_(user) === token ? user : null;
}

function mktLogin_(data) {
  // o login aceita maiúsculas ou minúsculas; a senha precisa ser exata
  var typed = mktKey_(data.user), user = null;
  for (var u in MKT_USERS) if (u.toUpperCase() === typed) user = u;
  if (!user || mktPassHash_(user, String(data.pass == null ? "" : data.pass)) !== MKT_USERS[user]) {
    return { ok: false, error: "Login ou senha incorretos" };
  }
  return { ok: true, user: user, token: mktToken_(user) };
}

// ===== PRESENÇA =====
// data = { action:"presence", token, dev, tab, active, leave }
// dev = navegador/dispositivo, tab = aba, active = aba visível na tela.
// Usa o bloqueio do documento, separado do bloqueio dos ajustes de estoque:
// um ajuste demorado não trava a presença.
function mktPresence_(data) {
  var user = mktUserOf_(data.token);
  if (!user) throw new Error("sessao expirada: entre de novo");
  var dev = String(data.dev || "").slice(0, 40), tab = String(data.tab || "").slice(0, 40);
  if (!dev || !tab) throw new Error("presenca sem identificador");
  var cache = CacheService.getScriptCache(), lock = LockService.getDocumentLock();
  var locked = !!lock && lock.tryLock(4000);
  try {
    var now = new Date().getTime(), map = {}, txt = cache.get(MKT_PRES_KEY);
    if (txt) { try { map = JSON.parse(txt); } catch (e) { map = {}; } }
    for (var k in map) if (now - map[k].t > MKT_PRES_TTL) delete map[k];
    var key = dev + "|" + tab;
    if (data.leave) delete map[key];
    else map[key] = { u: user, d: dev, a: !!data.active, t: now };
    if (locked) cache.put(MKT_PRES_KEY, JSON.stringify(map), 600);
  } finally {
    if (locked) lock.releaseLock();
  }
  // um navegador com várias abas conta uma vez; ativo se qualquer aba está visível
  var byDev = {}, sessions = [];
  for (var m in map) {
    var s = map[m], cur = byDev[s.d];
    if (cur) cur.active = cur.active || s.a;
    else { byDev[s.d] = { dev: s.d, user: s.u, active: s.a }; sessions.push(byDev[s.d]); }
  }
  return { ok: true, sessions: sessions };
}

// ===== RESPOSTA JSON =====

function pctJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== FORMATO ANTIGO (compatibilidade) =====
// { changes:[{cod, newTotal}] } → vira um ajuste "definir" com backup
function baixaEstoqueSite(data) {
  try {
    return pctJson_(mktWithLock_(function () { return mktApplyLegacy_(data); }));
  } catch (err) {
    return pctJson_({ ok: false, error: mktErr_(err) });
  }
}

// ===== UTIL =====

function mktErr_(err) { return String((err && err.message) || err); }
function mktKey_(v) { return String(v == null ? "" : v).replace(/^\s+|\s+$/g, "").toUpperCase(); }
function mktTz_() { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || "America/Sao_Paulo"; }
function mktHoje_() { return Utilities.formatDate(new Date(), mktTz_(), "dd/MM/yy"); } // mesmo formato de antes
function mktStamp_() { return Utilities.formatDate(new Date(), mktTz_(), "dd/MM/yyyy HH:mm:ss"); }
function mktNum_(v) {
  if (typeof v === "number") return v;
  var d = String(v == null ? "" : v).replace(/[^\d-]/g, "");
  return d && d !== "-" ? parseInt(d, 10) : 0;
}
function mktNorm_(v) {
  return String(v == null ? "" : v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function mktFindSheet_(nome, gid) {
  var abas = SpreadsheetApp.getActiveSpreadsheet().getSheets(), alvo = mktNorm_(nome);
  for (var i = 0; i < abas.length; i++) if (mktNorm_(abas[i].getName()) === alvo) return abas[i];
  if (gid != null) for (var j = 0; j < abas.length; j++) if (abas[j].getSheetId() === gid) return abas[j];
  return null;
}
function mktStockSheet_() {
  var sh = mktFindSheet_(CUBAS_ABA_NOME, GID_SITE_BAIXA);
  if (!sh) throw new Error("Aba " + CUBAS_ABA_NOME + " nao encontrada");
  mktInitCols_(sh);
  return sh;
}
// Acha COD., TOTAL UN e ATUALIZACAO no cabeçalho (primeiras 6 linhas).
function mktInitCols_(sh) {
  var lr = Math.min(6, Math.max(1, sh.getLastRow())), lc = Math.max(1, sh.getLastColumn());
  var h = sh.getRange(1, 1, lr, lc).getDisplayValues();
  for (var r = 0; r < h.length; r++) {
    var row = h[r].map(mktNorm_);
    var pick = function (names) { for (var k = 0; k < names.length; k++) { var i = row.indexOf(names[k]); if (i >= 0) return i + 1; } return 0; };
    var cod = pick(["COD", "CODIGO", "SKU"]), tot = pick(["TOTALUN", "TOTAL", "TOTALUNIDADES", "QTD", "ESTOQUE"]);
    if (!cod || !tot) continue;
    MKT_COL_COD = cod; MKT_COL_TOTAL = tot;
    MKT_COL_ATUAL = pick(["ATUALIZACAO", "ATUALIZADO", "DATA"]) || 8;
    break;
  }
  MKT_WIDTH = Math.max(MKT_COL_COD, MKT_COL_TOTAL, MKT_COL_ATUAL);
}
function mktAux_(name, header, hide) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name, ss.getSheets().length);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
    sh.setFrozenRows(1);
    if (hide) sh.hideSheet();
  }
  return sh;
}
var MKT_LOG_HEADER = ["Data/hora", "Lote", "Modo", "SKU", "Antes", "Qtd", "Depois", "Status", "Backup"];
function mktLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = mktFindSheet_(CUBAS_LOG_NOME, null) || ss.insertSheet(CUBAS_LOG_NOME, ss.getSheets().length);
  var first = sh.getRange(1, 1, 1, MKT_LOG_HEADER.length).getDisplayValues()[0].join("");
  if (!first) {
    sh.getRange(1, 1, 1, MKT_LOG_HEADER.length).setValues([MKT_LOG_HEADER]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}
function mktBkSheet_() {
  return mktAux_(MKT_BK_SHEET, ["ID", "Data/hora", "Tipo", "Descricao", "Lote", "Itens", "Dados"], true);
}
function mktWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Planilha ocupada com outra gravacao. Tente de novo em alguns segundos.");
  try { return fn(); } finally { lock.releaseLock(); }
}
function mktModeLabel_(m) { return m === "definir" ? "DEFINIR (=)" : m === "entrada" ? "ENTRADA (+)" : "BAIXA (-)"; }
function mktSameCell_(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return String(a) === String(b);
}

// ===== AJUSTE EM MASSA =====
// data = { action:"apply", batchId, mode:"saida"|"entrada"|"definir", items:[{cod, qty}] }
// O cálculo é feito AQUI com o valor ATUAL da planilha, dentro do lock.
// O mesmo batchId nunca é aplicado duas vezes.
function mktApplyBatch_(data) {
  var batchId = String(data.batchId || "").replace(/^\s+|\s+$/g, "");
  if (!batchId) throw new Error("lote sem batchId");
  var prev = mktBatchStatus_(batchId);
  if (prev.applied) { prev.duplicate = true; return prev; }

  var mode = (data.mode === "entrada" || data.mode === "definir") ? data.mode : "saida";
  var items = data.items || [];
  if (!items.length) throw new Error("lote vazio");

  var sh = mktStockSheet_();
  var values = sh.getRange(1, 1, sh.getLastRow(), MKT_WIDTH).getValues();

  // backup completo ANTES de mexer
  var bk = mktCreateBackup_("auto", "Antes do ajuste " + mktModeLabel_(mode) + " - " + items.length + " SKU(s)", batchId, values);

  var rowOf = {};
  for (var i = 0; i < values.length; i++) {
    var k = mktKey_(values[i][MKT_COL_COD - 1]);
    if (k && !rowOf.hasOwnProperty(k)) rowOf[k] = i;
  }

  // soma SKUs repetidos no mesmo lote
  var merged = {}, order = [];
  for (var j = 0; j < items.length; j++) {
    var kk = mktKey_(items[j].cod);
    if (!kk) continue;
    var q = Math.max(0, mktNum_(items[j].qty));
    if (merged.hasOwnProperty(kk)) merged[kk].qty = mode === "definir" ? q : merged[kk].qty + q;
    else { merged[kk] = { cod: String(items[j].cod).replace(/^\s+|\s+$/g, ""), qty: q }; order.push(kk); }
  }

  var now = new Date(), hoje = mktHoje_();
  var updated = [], skipped = [], notFound = [], log = [];
  for (var o = 0; o < order.length; o++) {
    var it = merged[order[o]], r = rowOf[order[o]];
    if (r == null) {
      notFound.push(it.cod);
      log.push([now, batchId, mode, it.cod, "", it.qty, "", "nao encontrado", bk.id]);
      continue;
    }
    var before = mktNum_(values[r][MKT_COL_TOTAL - 1]);
    var after = mode === "definir" ? it.qty : mode === "entrada" ? before + it.qty : before - it.qty;
    if (after < 0) {
      skipped.push({ cod: it.cod, before: before, after: after });
      log.push([now, batchId, mode, it.cod, before, it.qty, after, "ignorado: ficaria negativo", bk.id]);
      continue;
    }
    sh.getRange(r + 1, MKT_COL_TOTAL).setValue(after);
    sh.getRange(r + 1, MKT_COL_ATUAL).setValue(hoje);
    updated.push({ cod: it.cod, row: r + 1, before: before, after: after, qty: it.qty });
  }
  SpreadsheetApp.flush();

  // confere o que ficou gravado
  var mismatch = [];
  for (var u = 0; u < updated.length; u++) {
    var ok = mktNum_(sh.getRange(updated[u].row, MKT_COL_TOTAL).getValue()) === updated[u].after;
    if (!ok) mismatch.push(updated[u].cod);
    log.push([now, batchId, mode, updated[u].cod, updated[u].before, updated[u].qty, updated[u].after,
      ok ? "ok" : "ERRO: nao conferiu", bk.id]);
  }
  if (log.length) {
    var ls = mktLogSheet_();
    ls.getRange(ls.getLastRow() + 1, 1, log.length, log[0].length).setValues(log);
  }
  return { ok: true, batchId: batchId, backupId: bk.id, updated: updated, skipped: skipped, notFound: notFound, mismatch: mismatch };
}

function mktApplyLegacy_(data) {
  var ch = data.changes || [], items = [];
  for (var i = 0; i < ch.length; i++) items.push({ cod: ch[i].cod, qty: ch[i].newTotal });
  return mktApplyBatch_({ batchId: "legacy-" + new Date().getTime(), mode: "definir", items: items });
}

// O lote já foi aplicado? (o log é a prova)
function mktBatchStatus_(batchId) {
  batchId = String(batchId || "").replace(/^\s+|\s+$/g, "");
  if (!batchId) return { ok: true, applied: false };
  var ls = mktFindSheet_(CUBAS_LOG_NOME, null);
  if (!ls || ls.getLastRow() < 2) return { ok: true, applied: false };
  var all = ls.getRange(2, 1, ls.getLastRow() - 1, 9).getValues();
  var updated = [], skipped = [], notFound = [], mismatch = [], backupId = "", found = false;
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (String(r[1]) !== batchId) continue;
    found = true; backupId = String(r[8]);
    var st = String(r[7]), cod = String(r[3]);
    if (st === "ok") updated.push({ cod: cod, before: r[4], after: r[6] });
    else if (st.indexOf("ERRO") === 0) { updated.push({ cod: cod, before: r[4], after: r[6] }); mismatch.push(cod); }
    else if (st === "nao encontrado") notFound.push(cod);
    else skipped.push({ cod: cod, before: r[4], after: r[6] });
  }
  if (!found) return { ok: true, applied: false };
  return { ok: true, applied: true, batchId: batchId, backupId: backupId, updated: updated, skipped: skipped, notFound: notFound, mismatch: mismatch };
}

// ===== BACKUPS =====
// Guarda TOTAL UN (C) e ATUALIZACAO (H) de TODAS as linhas com SKU.
function mktCreateBackup_(tipo, desc, lote, values) {
  var sh = mktStockSheet_();
  if (!values) values = sh.getRange(1, 1, sh.getLastRow(), MKT_WIDTH).getValues();
  var snap = [];
  for (var i = 0; i < values.length; i++) {
    var cod = String(values[i][MKT_COL_COD - 1]).replace(/^\s+|\s+$/g, "");
    if (!cod) continue;
    var at = values[i][MKT_COL_ATUAL - 1];
    snap.push([i + 1, cod, values[i][MKT_COL_TOTAL - 1], at instanceof Date ? "D" + at.getTime() : at]);
  }
  var txt = JSON.stringify(snap), chunks = [];
  for (var c = 0; c < txt.length; c += MKT_CHUNK) chunks.push(txt.slice(c, c + MKT_CHUNK));
  var id = Utilities.formatDate(new Date(), mktTz_(), "yyyyMMdd-HHmmss") + "-" + Math.floor(Math.random() * 1000);
  var at2 = mktStamp_();
  var row = [id, at2, tipo, desc, lote || "", String(snap.length)].concat(chunks);
  var bs = mktBkSheet_();
  bs.getRange(bs.getLastRow() + 1, 1, 1, row.length).setNumberFormat("@").setValues([row]);
  var extra = bs.getLastRow() - 1 - MKT_MAX_BACKUPS; // poda os mais antigos
  if (extra > 0) bs.deleteRows(2, extra);
  return { id: id, at: at2, tipo: tipo, desc: desc, itens: snap.length };
}

function mktListBackups_() {
  var bs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MKT_BK_SHEET);
  if (!bs || bs.getLastRow() < 2) return [];
  var v = bs.getRange(2, 1, bs.getLastRow() - 1, 6).getDisplayValues(), out = [];
  for (var i = v.length - 1; i >= 0; i--) {
    out.push({ id: v[i][0], at: v[i][1], tipo: v[i][2], desc: v[i][3], lote: v[i][4], itens: Number(v[i][5]) || 0 });
  }
  return out;
}

function mktReadBackup_(id) {
  var bs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MKT_BK_SHEET);
  if (!bs || bs.getLastRow() < 2) throw new Error("nenhum backup encontrado");
  var all = bs.getRange(2, 1, bs.getLastRow() - 1, bs.getLastColumn()).getDisplayValues();
  for (var i = 0; i < all.length; i++) {
    if (all[i][0] === String(id)) {
      var r = all[i];
      return { meta: { id: r[0], at: r[1], tipo: r[2], desc: r[3], lote: r[4] }, snap: JSON.parse(r.slice(6).join("")) };
    }
  }
  throw new Error("backup " + id + " nao encontrado");
}

// soLote=true  → "Desfazer ajuste": volta só os SKUs alterados naquele ajuste
// soLote=false → "Restaurar tudo": volta a aba inteira para o momento do backup
function mktRestore_(id, soLote) {
  var bk = mktReadBackup_(id);
  var only = null;
  if (soLote) {
    if (!bk.meta.lote) throw new Error("este backup nao esta ligado a um ajuste; use 'Restaurar tudo'");
    var st = mktBatchStatus_(bk.meta.lote);
    only = {};
    var cnt = 0;
    for (var u = 0; u < (st.updated || []).length; u++) { only[mktKey_(st.updated[u].cod)] = true; cnt++; }
    if (!cnt) throw new Error("esse ajuste nao alterou nenhum SKU");
  }
  var sh = mktStockSheet_();
  var values = sh.getRange(1, 1, sh.getLastRow(), MKT_WIDTH).getValues();
  var safety = mktCreateBackup_("restauracao", "Antes de " + (soLote ? "desfazer ajuste" : "restaurar") + " " + bk.meta.at, "", values);

  // casa por SKU + ordem de ocorrência (para SKUs repetidos)
  var occ = {}, cur = {};
  for (var i = 0; i < values.length; i++) {
    var k = mktKey_(values[i][MKT_COL_COD - 1]);
    if (!k) continue;
    occ[k] = (occ[k] || 0) + 1;
    cur[k + "#" + occ[k]] = i;
  }
  var occB = {}, now = new Date(), lote = "RESTAURA-" + id, log = [], changed = 0, missing = [];
  for (var s = 0; s < bk.snap.length; s++) {
    var e = bk.snap[s], kb = mktKey_(e[1]);
    occB[kb] = (occB[kb] || 0) + 1;
    if (only && !only[kb]) continue;
    var idx = cur[kb + "#" + occB[kb]];
    if (idx == null) { missing.push(e[1]); continue; }
    var total = e[2];
    var at = (typeof e[3] === "string" && /^D-?\d+$/.test(e[3])) ? new Date(Number(e[3].slice(1))) : e[3];
    var before = values[idx][MKT_COL_TOTAL - 1];
    var sameTotal = mktSameCell_(before, total), sameAt = mktSameCell_(values[idx][MKT_COL_ATUAL - 1], at);
    if (sameTotal && sameAt) continue;
    if (!sameTotal) sh.getRange(idx + 1, MKT_COL_TOTAL).setValue(total);
    if (!sameAt) sh.getRange(idx + 1, MKT_COL_ATUAL).setValue(at);
    changed++;
    if (!sameTotal) log.push([now, lote, soLote ? "desfazer" : "restaurar", e[1], before, "", total, "ok", safety.id]);
  }
  SpreadsheetApp.flush();
  if (log.length) {
    var ls = mktLogSheet_();
    ls.getRange(ls.getLastRow() + 1, 1, log.length, log[0].length).setValues(log);
  }
  return { ok: true, restored: changed, totalChanged: log.length, missing: missing, safetyBackupId: safety.id, from: bk.meta };
}

// ===== BACKUP DIÁRIO (opcional) =====
// Acionadores (relógio) → Adicionar acionador → função backupDiarioCubas →
// Baseado no tempo → Contador de dias → escolha o horário.
function backupDiarioCubas() {
  mktWithLock_(function () { return mktCreateBackup_("diario", "Backup automatico diario", "", null); });
}

// ===== SENHAS =====
// Execute no editor do Apps Script e veja o hash em "Registro de execução".
// Os hashes são iguais aos do Estoque MKT, então as mesmas senhas valem aqui.
function mktGerarHash() {
  var usuario = "novo_usuario", senha = "nova_senha";
  Logger.log(usuario + ": " + mktPassHash_(usuario, senha));
}

// Rode uma vez pelo editor: autoriza o script e mostra o que ele encontrou.
function cubasTeste() {
  var sh = mktStockSheet_();
  Logger.log("Aba: " + sh.getName() + " | COD=col " + MKT_COL_COD + " TOTAL=col " + MKT_COL_TOTAL + " ATUAL=col " + MKT_COL_ATUAL);
  Logger.log("Log: " + mktLogSheet_().getName());
}
