# Wallet Tracker

Controle financeiro pessoal direto no Obsidian: contas bancárias, cartões de
crédito com fatura automática, despesas, receitas, metas de economia,
parcelamentos, recorrências, transferências entre contas — tudo num painel
lateral, sem precisar de planilha.

## Funcionalidades

### Contas e cartões
- Contas bancárias com saldo e cor personalizada
- Cartões de crédito com limite, dia de fechamento e dia de vencimento
- Fatura calculada automaticamente a partir da data de cada compra
- Histórico completo de faturas (em aberto, aguardando pagamento, pagas)
- Pagamento de fatura debitando de uma conta bancária à sua escolha

### Lançamentos
- Despesas e receitas com valor, descrição, categoria, conta e data
- Três tipos de lançamento:
  - **Único** — lançamento pontual, com toggle Pago/Recebido (se desligado,
    fica pendente até você confirmar)
  - **Parcelamento** — divide o valor em N parcelas; em cartão, as parcelas
    caem sozinhas nas faturas dos meses seguintes
  - **Recorrente** — se repete todo mês automaticamente até ser excluído
- Transferências entre contas bancárias (não afeta os totais de despesa/receita)

### Metas
- Metas de economia com valor alvo, prazo e conta vinculada
- Aportes que descontam automaticamente de uma conta, se você quiser

### Visão Geral
- Resumo com 7 indicadores: saldo atual, receitas, despesas, a receber,
  a pagar, balanceamento geral e valor guardado em metas
- Filtro por mês (inclusive meses futuros), mostrando inclusive o que ainda
  não foi lançado de verdade — parcelas futuras, faturas futuras e
  recorrências previstas aparecem esmaecidas, com a opção de confirmar o
  pagamento antes da hora
- Filtro por categoria: Todos / Despesas / Receitas / A pagar

### Outros
- Compatível com Obsidian Mobile (iOS/Android), com botões e espaçamentos
  adaptados para toque
- Todos os dados ficam salvos localmente, dentro do próprio vault

## Instalação manual

1. Baixe os arquivos `manifest.json`, `main.js` e `styles.css`.
2. Copie os três para `SeuVault/.obsidian/plugins/wallet-tracker/`
   (crie a pasta `wallet-tracker` se ela não existir).
3. No Obsidian, vá em **Configurações → Community Plugins**, desative o
   "Restricted mode" se estiver ativo, e ative o **Wallet Tracker** na lista.
4. Clique no ícone de carteira na barra lateral para abrir o painel.

## Uso
1. Adicione em CONTAS seus bancos e cores.
2. Adicione os valores nas contas.
3. Adicione seus cartões de credito.
4. Adicione seus parcelamentos.
5. Adicione despesas fixas e despesas do dia-a-dia.

Depois é só adicionar manualmente todos seus ganhos e gastos.

## Uso dos dados

Todas as informações (contas, cartões, lançamentos, metas, faturas) ficam
armazenadas localmente em `data.json`, dentro da pasta do plugin no seu
vault. Nada é enviado para fora do seu computador.

## Autor

Atlas Society

## Licença

Distribuído sob a licença MIT — veja o arquivo [LICENSE](LICENSE).
