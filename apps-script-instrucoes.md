# Apps Script do Estoque Cubas — login, presença, ajuste em massa seguro + backups

O site é estático e só **lê** a planilha. Para gravar (Aprovar mudanças, Backups)
ele chama um Apps Script publicado dentro da própria planilha.

Planilha: https://docs.google.com/spreadsheets/d/1eMEkO2BB42c-SVb0NRhgFoC7dPgW6005Ra0mNZ_e7Y4

## 1. Deixar a planilha legível pelo site

**Compartilhar → Acesso geral → Qualquer pessoa com o link → Leitor.**
Sem isso o site não consegue carregar o estoque.

## 2. Colar e publicar o script (fazer UMA vez)

1. Na planilha: **Extensões → Apps Script**.
2. Apague o que estiver no editor, cole TODO o conteúdo de `apps-script.gs` e salve (Ctrl+S).
3. No menu de funções escolha **cubasTeste** → **Executar** → autorize
   (*Avançado → Acessar ... (não seguro)* — é o seu próprio script).
   O Registro de execução mostra a aba e as colunas que ele encontrou.
4. **Implantar → Nova implantação → engrenagem → App da Web**
   - Executar como: **Eu**
   - Quem pode acessar: **Qualquer pessoa**
   → **Implantar** e copie a URL que termina em `/exec`.
5. Teste: abra `SUA_URL?action=ping` → deve mostrar `{"ok":true,"version":3}`.
6. Coloque a URL no `index.html` (linha `SCRIPT_URL = "..."`) e publique o site.

Para mudanças futuras no script: **Implantar → Gerenciar implantações → lápis →
Nova versão → Implantar** (a URL continua a mesma). Salvar sozinho não publica.

## Abas usadas

- **ESTOQUE CUBAS** — banco de dados do site. As colunas são achadas pelo nome do
  cabeçalho: COD., DESCRICAO, TOTAL UN, POR CX, C. FECHADA, C. ABERTA,
  LOCALIZACAO, ATUALIZACAO, VERIFICADO. Sem cabeçalho, vale A..I como no Estoque MKT.
  O site grava só TOTAL UN e ATUALIZACAO.
- **_LOG_AJUSTES_CUBAS** — histórico de cada SKU alterado (data/hora, lote, modo, antes,
  quantidade, depois, status, backup). Se a linha 1 estiver vazia, o script escreve o cabeçalho.
- **_BACKUPS_CUBAS** (oculta, criada sozinha) — um backup por linha, guarda os últimos 200.

Não apague nem edite essas abas à mão.

## Logins

Os mesmos do Estoque MKT (user64, adm, Silvia, Givaldo, userFL, userDF; senha = login).
Para criar ou trocar: edite usuário e senha em `mktGerarHash`, execute, copie o hash do
Registro de execução para `MKT_USERS` e publique uma Nova versão.

## Botão "Backups" no site

- **Desfazer ajuste** — volta só os SKUs daquele ajuste.
- **Restaurar tudo** — volta TOTAL UN e ATUALIZAÇÃO da aba inteira para aquele momento.
- **Criar backup agora** — ponto de restauração manual.
- Toda restauração cria antes um backup do estado atual.

## (Opcional) Backup diário automático

Apps Script → **Acionadores → Adicionar acionador** → função `backupDiarioCubas` →
*Baseado no tempo* → *Contador de dias* → horário → Salvar.
