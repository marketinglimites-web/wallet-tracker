const { Plugin, ItemView, Modal, Setting, Notice, ToggleComponent } = require('obsidian');

const VIEW_TYPE_WALLET = 'wallet-tracker-view';

/* ---------------------------- Helpers ---------------------------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatCurrency(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateBR(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('pt-BR');
}

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function addMonthsISO(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function clampDayOfMonth(year, month, day) {
  // month is 1-12. new Date(year, month, 0) gives the last day of that month.
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.min(day, daysInMonth);
}

function addMonthsToCompetencia(comp, n) {
  const total = comp.month - 1 + n;
  const year = comp.year + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12 + 1;
  return { year, month };
}

// Given a card's closing/due days and a charge date, figures out which
// monthly invoice ("fatura") the charge belongs to.
function computeInvoiceCycle(card, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let comp = { year: y, month: m };
  if (d > card.closingDay) comp = addMonthsToCompetencia(comp, 1);

  const closingDay = clampDayOfMonth(comp.year, comp.month, card.closingDay);
  const closingDate = `${comp.year}-${pad2(comp.month)}-${pad2(closingDay)}`;

  let dueComp = comp;
  if (card.dueDay < card.closingDay) dueComp = addMonthsToCompetencia(comp, 1);
  const dueDay = clampDayOfMonth(dueComp.year, dueComp.month, card.dueDay);
  const dueDate = `${dueComp.year}-${pad2(dueComp.month)}-${pad2(dueDay)}`;

  return { competencia: `${comp.year}-${pad2(comp.month)}`, closingDate, dueDate };
}

function getOrCreateInvoice(data, card, dateStr) {
  const { competencia, closingDate, dueDate } = computeInvoiceCycle(card, dateStr);
  let invoice = data.invoices.find((i) => i.cardId === card.id && i.competencia === competencia);
  if (!invoice) {
    invoice = {
      id: uid(),
      cardId: card.id,
      competencia,
      closingDate,
      dueDate,
      paid: false,
      paidDate: null,
      paidFromAccountId: null,
    };
    data.invoices.push(invoice);
  }
  return invoice;
}

function addCardCharge(data, cardId, charge) {
  const card = data.cards.find((c) => c.id === cardId);
  if (!card) return null;
  const invoice = getOrCreateInvoice(data, card, charge.date);
  const record = {
    id: uid(),
    cardId,
    invoiceId: invoice.id,
    amount: charge.amount,
    description: charge.description || '',
    category: charge.category || '',
    date: charge.date,
    recurrenceId: charge.recurrenceId || null,
  };
  data.cardCharges.push(record);
  return record;
}

function getInvoiceTotal(data, invoiceId) {
  return data.cardCharges.filter((c) => c.invoiceId === invoiceId).reduce((s, c) => s + c.amount, 0);
}

function generateRecurringOccurrence(data, rule, date) {
  const card = data.cards.find((c) => c.id === rule.accountId);
  if (card) {
    addCardCharge(data, card.id, {
      amount: rule.amount,
      description: rule.description,
      category: rule.category,
      date,
      recurrenceId: rule.id,
    });
    return;
  }

  const acc = data.accounts.find((a) => a.id === rule.accountId);
  if (acc) {
    if (rule.type === 'despesa') acc.balance -= rule.amount;
    else acc.balance += rule.amount;
  }
  data.transactions.push({
    id: uid(),
    accountId: rule.accountId,
    type: rule.type,
    amount: rule.amount,
    category: rule.category || '',
    description: rule.description || '',
    date,
    paid: true,
    recurrenceId: rule.id,
  });
}

// Fills in any monthly occurrences that should have happened since the rule was
// last generated, up to today. Runs once when the plugin loads. Returns true if
// it changed anything (so the caller knows whether to persist).
function processRecurrences(data) {
  const today = todayISO();
  let changed = false;
  (data.recurrences || []).forEach((rule) => {
    if (!rule.active) return;
    let next = addMonthsISO(rule.lastGeneratedDate, 1);
    while (next <= today) {
      generateRecurringOccurrence(data, rule, next);
      rule.lastGeneratedDate = next;
      changed = true;
      next = addMonthsISO(next, 1);
    }
  });
  return changed;
}

function emptyData() {
  return {
    accounts: [],
    transactions: [],
    goals: [],
    installments: [],
    receivables: [],
    recurrences: [],
    cards: [],
    invoices: [],
    cardCharges: [],
    transfers: [],
  };
}

/* ============================================================
   MODALS
   ============================================================ */

const DEFAULT_ACCOUNT_COLORS = ['#4c8bf5', '#4caf50', '#e57373', '#ffb74d', '#ba68c8', '#4dd0c4', '#ffd54f'];

class AccountModal extends Modal {
  constructor(app, existing, onSubmit) {
    super(app);
    this.existing = existing || null;
    this.onSubmit = onSubmit;
    this.name = existing ? existing.name : '';
    this.balance = existing ? existing.balance : 0;
    this.color = existing && existing.color ? existing.color : DEFAULT_ACCOUNT_COLORS[Math.floor(Math.random() * DEFAULT_ACCOUNT_COLORS.length)];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.existing ? 'Editar conta' : 'Nova conta' });

    new Setting(contentEl)
      .setName('Nome da conta')
      .setDesc('Ex: Nubank, Itaú, Carteira, Dinheiro em espécie')
      .addText((text) => {
        text.setValue(this.name);
        text.onChange((v) => (this.name = v));
        text.inputEl.focus();
      });

    new Setting(contentEl)
      .setName(this.existing ? 'Saldo atual' : 'Saldo inicial')
      .setDesc('Valor atual da conta em reais')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.step = '0.01';
        text.setValue(String(this.balance));
        text.onChange((v) => (this.balance = parseFloat(v) || 0));
      });

    new Setting(contentEl)
      .setName('Cor da conta')
      .setDesc('Aparece na lateral do card, igual as cores da Visão Geral')
      .addColorPicker((picker) => {
        picker.setValue(this.color);
        picker.onChange((v) => (this.color = v));
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText(this.existing ? 'Salvar' : 'Criar conta')
        .setCta()
        .onClick(() => {
          if (!this.name.trim()) {
            new Notice('Dê um nome para a conta.');
            return;
          }
          this.onSubmit({ name: this.name.trim(), balance: this.balance, color: this.color });
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CardModal extends Modal {
  constructor(app, existing, onSubmit) {
    super(app);
    this.existing = existing || null;
    this.onSubmit = onSubmit;
    this.name = existing ? existing.name : '';
    this.limit = existing ? existing.limit : 0;
    this.closingDay = existing ? existing.closingDay : 20;
    this.dueDay = existing ? existing.dueDay : 27;
    this.color = existing && existing.color ? existing.color : DEFAULT_ACCOUNT_COLORS[Math.floor(Math.random() * DEFAULT_ACCOUNT_COLORS.length)];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.existing ? 'Editar cartão' : 'Novo cartão' });

    new Setting(contentEl)
      .setName('Nome do cartão')
      .setDesc('Ex: Nubank Ultravioleta, Inter Gold')
      .addText((text) => {
        text.setValue(this.name);
        text.onChange((v) => (this.name = v));
        text.inputEl.focus();
      });

    new Setting(contentEl).setName('Limite (R$)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '0.01';
      text.setValue(String(this.limit));
      text.onChange((v) => (this.limit = parseFloat(v) || 0));
    });

    new Setting(contentEl).setName('Dia de fechamento').setDesc('Dia do mês em que a fatura fecha (1-31)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '1';
      text.setValue(String(this.closingDay));
      text.onChange((v) => (this.closingDay = Math.min(31, Math.max(1, parseInt(v) || 1))));
    });

    new Setting(contentEl).setName('Dia de vencimento').setDesc('Dia do mês em que a fatura vence (1-31)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '1';
      text.setValue(String(this.dueDay));
      text.onChange((v) => (this.dueDay = Math.min(31, Math.max(1, parseInt(v) || 1))));
    });

    new Setting(contentEl).setName('Cor do cartão').addColorPicker((picker) => {
      picker.setValue(this.color);
      picker.onChange((v) => (this.color = v));
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText(this.existing ? 'Salvar' : 'Criar cartão')
        .setCta()
        .onClick(() => {
          if (!this.name.trim()) {
            new Notice('Dê um nome para o cartão.');
            return;
          }
          this.onSubmit({
            name: this.name.trim(),
            limit: this.limit,
            closingDay: this.closingDay,
            dueDay: this.dueDay,
            color: this.color,
          });
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PayInvoiceModal extends Modal {
  constructor(app, accounts, invoiceTotal, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.invoiceTotal = invoiceTotal;
    this.onSubmit = onSubmit;
    this.accountId = accounts[0] ? accounts[0].id : null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Pagar fatura' });
    contentEl.createEl('p', { text: `Valor total: ${formatCurrency(this.invoiceTotal)}` });

    if (this.accounts.length === 0) {
      contentEl.createEl('p', { text: 'Crie uma conta bancária primeiro.' });
      return;
    }

    new Setting(contentEl).setName('Pagar com a conta').addDropdown((drop) => {
      this.accounts.forEach((a) => drop.addOption(a.id, a.name));
      drop.setValue(this.accountId);
      drop.onChange((v) => (this.accountId = v));
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Confirmar pagamento')
        .setCta()
        .onClick(() => {
          if (!this.accountId) {
            new Notice('Selecione uma conta.');
            return;
          }
          this.onSubmit({ accountId: this.accountId });
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TransferModal extends Modal {
  constructor(app, accounts, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.onSubmit = onSubmit;
    this.data = {
      amount: 0,
      description: '',
      fromAccountId: accounts[0] ? accounts[0].id : null,
      toAccountId: accounts[1] ? accounts[1].id : (accounts[0] ? accounts[0].id : null),
      date: todayISO(),
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Transferência entre contas' });

    if (this.accounts.length < 2) {
      contentEl.createEl('p', { text: 'Você precisa de pelo menos 2 contas bancárias para transferir.' });
      return;
    }

    new Setting(contentEl).setName('Valor (R$)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '0.01';
      text.inputEl.focus();
      text.onChange((v) => (this.data.amount = parseFloat(v) || 0));
    });

    new Setting(contentEl).setName('Descrição').setDesc('Opcional').addText((text) => {
      text.onChange((v) => (this.data.description = v));
    });

    new Setting(contentEl).setName('Conta de origem').addDropdown((drop) => {
      this.accounts.forEach((a) => drop.addOption(a.id, a.name));
      drop.setValue(this.data.fromAccountId);
      drop.onChange((v) => (this.data.fromAccountId = v));
    });

    new Setting(contentEl).setName('Conta de destino').addDropdown((drop) => {
      this.accounts.forEach((a) => drop.addOption(a.id, a.name));
      drop.setValue(this.data.toAccountId);
      drop.onChange((v) => (this.data.toAccountId = v));
    });

    new Setting(contentEl).setName('Data').addText((text) => {
      text.inputEl.type = 'date';
      text.setValue(this.data.date);
      text.onChange((v) => (this.data.date = v || todayISO()));
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Transferir')
        .setCta()
        .onClick(() => {
          if (!this.data.amount || this.data.amount <= 0) {
            new Notice('Informe um valor maior que zero.');
            return;
          }
          if (this.data.fromAccountId === this.data.toAccountId) {
            new Notice('Escolha duas contas diferentes.');
            return;
          }
          this.onSubmit(this.data);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class EntryModal extends Modal {
  constructor(app, accounts, cards, txType, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.cards = cards || [];
    this.txType = txType; // 'despesa' | 'ganho'
    this.onSubmit = onSubmit;
    this.data = {
      amount: 0,
      description: '',
      tipo: 'unico', // 'unico' | 'parcelamento' | 'recorrente'
      accountId: accounts[0] ? accounts[0].id : null,
      category: '',
      date: todayISO(),
      paid: true,
      installmentsCount: 2,
    };
  }

  isCardSelected() {
    return this.txType === 'despesa' && this.cards.some((c) => c.id === this.data.accountId);
  }

  onOpen() {
    const { contentEl } = this;
    const isDespesa = this.txType === 'despesa';
    contentEl.createEl('h2', { text: isDespesa ? 'Nova despesa' : 'Nova receita' });

    if (this.accounts.length === 0 && this.cards.length === 0) {
      contentEl.createEl('p', { text: 'Crie uma conta primeiro.' });
      return;
    }

    new Setting(contentEl).setName('Valor (R$)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '0.01';
      text.inputEl.focus();
      text.onChange((v) => (this.data.amount = parseFloat(v) || 0));
    });

    new Setting(contentEl).setName('Descrição').addText((text) => {
      text.onChange((v) => (this.data.description = v));
    });

    new Setting(contentEl).setName('Tipo').addDropdown((drop) => {
      drop.addOption('unico', 'Único');
      drop.addOption('parcelamento', 'Parcelamento');
      drop.addOption('recorrente', 'Recorrente');
      drop.setValue(this.data.tipo);
      drop.onChange((v) => {
        this.data.tipo = v;
        this.renderDynamicFields();
      });
    });

    new Setting(contentEl).setName('Conta').addDropdown((drop) => {
      this.accounts.forEach((a) => drop.addOption(a.id, a.name));
      if (isDespesa) {
        this.cards.forEach((c) => drop.addOption(c.id, `${c.name} (cartão)`));
      }
      drop.setValue(this.data.accountId);
      drop.onChange((v) => {
        this.data.accountId = v;
        this.renderDynamicFields();
      });
    });

    new Setting(contentEl).setName('Categoria').addText((text) => {
      text.onChange((v) => (this.data.category = v));
    });

    new Setting(contentEl).setName('Data').addText((text) => {
      text.inputEl.type = 'date';
      text.setValue(this.data.date);
      text.onChange((v) => (this.data.date = v || todayISO()));
    });

    this.dynamicContainer = contentEl.createDiv();
    this.renderDynamicFields();

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Salvar')
        .setCta()
        .onClick(() => this.handleSubmit())
    );
  }

  renderDynamicFields() {
    this.dynamicContainer.empty();
    const isDespesa = this.txType === 'despesa';
    const isCard = this.isCardSelected();

    if (this.data.tipo === 'parcelamento') {
      const desc = isCard
        ? 'As parcelas caem automaticamente nas próximas faturas do cartão'
        : 'Vai aparecer na aba Parcelamentos / A Receber';
      new Setting(this.dynamicContainer).setName('Quantas parcelas').setDesc(desc).addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.step = '1';
        text.setValue(String(this.data.installmentsCount));
        text.onChange((v) => (this.data.installmentsCount = Math.max(2, parseInt(v) || 2)));
      });
    } else if (isCard) {
      this.dynamicContainer.createEl('p', {
        text: 'Lançamentos no cartão entram direto na fatura em aberto.',
        cls: 'wt-muted',
      });
    } else {
      new Setting(this.dynamicContainer)
        .setName(isDespesa ? 'Pago' : 'Recebido')
        .setDesc(
          isDespesa
            ? 'Se desligado, fica pendente e aparece em "A pagar"'
            : 'Se desligado, fica pendente e aparece em "A Receber"'
        )
        .addToggle((toggle) => {
          toggle.setValue(this.data.paid);
          toggle.onChange((v) => (this.data.paid = v));
        });
    }
  }

  handleSubmit() {
    if (!this.data.accountId) {
      new Notice('Selecione uma conta.');
      return;
    }
    if (!this.data.amount || this.data.amount <= 0) {
      new Notice('Informe um valor maior que zero.');
      return;
    }
    this.onSubmit(this.data);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmRecurrenceDeleteModal extends Modal {
  constructor(app, onlyThis, allOfThem) {
    super(app);
    this.onlyThis = onlyThis;
    this.allOfThem = allOfThem;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Excluir lançamento recorrente' });
    contentEl.createEl('p', {
      text: 'Esse lançamento faz parte de uma recorrência mensal. O que você quer excluir?',
    });
    const row = contentEl.createDiv({ cls: 'wt-actions' });

    const onlyBtn = row.createEl('button', { text: 'Excluir somente esta', cls: 'wt-btn' });
    onlyBtn.onclick = () => {
      this.onlyThis();
      this.close();
    };

    const allBtn = row.createEl('button', { text: 'Excluir toda a recorrência', cls: 'wt-btn wt-btn-danger' });
    allBtn.onclick = () => {
      this.allOfThem();
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GoalModal extends Modal {
  constructor(app, accounts, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.onSubmit = onSubmit;
    this.data = {
      name: '',
      target: 0,
      current: 0,
      deadline: '',
      accountId: '',
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Nova meta' });

    new Setting(contentEl).setName('Nome da meta').setDesc('Ex: Viagem, reserva de emergência').addText((text) => {
      text.onChange((v) => (this.data.name = v));
      text.inputEl.focus();
    });

    new Setting(contentEl).setName('Valor alvo (R$)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '0.01';
      text.onChange((v) => (this.data.target = parseFloat(v) || 0));
    });

    new Setting(contentEl).setName('Valor já guardado (R$)').setDesc('Opcional, padrão 0').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '0.01';
      text.setValue('0');
      text.onChange((v) => (this.data.current = parseFloat(v) || 0));
    });

    new Setting(contentEl).setName('Prazo').setDesc('Opcional').addText((text) => {
      text.inputEl.type = 'date';
      text.onChange((v) => (this.data.deadline = v));
    });

    new Setting(contentEl).setName('Conta vinculada').setDesc('Opcional, usada ao adicionar valor à meta').addDropdown((drop) => {
      drop.addOption('', 'Nenhuma');
      this.accounts.forEach((a) => drop.addOption(a.id, a.name));
      drop.onChange((v) => (this.data.accountId = v));
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Criar meta')
        .setCta()
        .onClick(() => {
          if (!this.data.name.trim()) {
            new Notice('Dê um nome para a meta.');
            return;
          }
          if (!this.data.target || this.data.target <= 0) {
            new Notice('Informe um valor alvo maior que zero.');
            return;
          }
          this.onSubmit(this.data);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GoalContributionModal extends Modal {
  constructor(app, accounts, goal, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.goal = goal;
    this.onSubmit = onSubmit;
    this.amount = 0;
    this.accountId = goal.accountId || '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: `Adicionar valor à meta "${this.goal.name}"` });

    new Setting(contentEl).setName('Valor a adicionar (R$)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '0.01';
      text.inputEl.focus();
      text.onChange((v) => (this.amount = parseFloat(v) || 0));
    });

    new Setting(contentEl)
      .setName('Descontar de uma conta?')
      .setDesc('Se escolher uma conta, o valor sai do saldo dela')
      .addDropdown((drop) => {
        drop.addOption('', 'Não descontar de conta nenhuma');
        this.accounts.forEach((a) => drop.addOption(a.id, a.name));
        drop.setValue(this.accountId);
        drop.onChange((v) => (this.accountId = v));
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Adicionar')
        .setCta()
        .onClick(() => {
          if (!this.amount || this.amount <= 0) {
            new Notice('Informe um valor maior que zero.');
            return;
          }
          this.onSubmit({ amount: this.amount, accountId: this.accountId });
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class InstallmentModal extends Modal {
  constructor(app, accounts, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.onSubmit = onSubmit;
    this.data = {
      description: '',
      totalAmount: 0,
      installmentsCount: 2,
      accountId: accounts[0] ? accounts[0].id : null,
      startDate: todayISO(),
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Novo parcelamento' });

    if (this.accounts.length === 0) {
      contentEl.createEl('p', { text: 'Crie uma conta primeiro.' });
      return;
    }

    new Setting(contentEl).setName('Descrição').setDesc('Ex: Celular novo, Sofá').addText((text) => {
      text.inputEl.focus();
      text.onChange((v) => (this.data.description = v));
    });

    new Setting(contentEl).setName('Valor total (R$)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '0.01';
      text.onChange((v) => (this.data.totalAmount = parseFloat(v) || 0));
    });

    new Setting(contentEl).setName('Número de parcelas').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '1';
      text.setValue('2');
      text.onChange((v) => (this.data.installmentsCount = Math.max(1, parseInt(v) || 1)));
    });

    new Setting(contentEl).setName('Conta usada para pagar').addDropdown((drop) => {
      this.accounts.forEach((a) => drop.addOption(a.id, a.name));
      drop.setValue(this.data.accountId);
      drop.onChange((v) => (this.data.accountId = v));
    });

    new Setting(contentEl).setName('Data da 1ª parcela').addText((text) => {
      text.inputEl.type = 'date';
      text.setValue(this.data.startDate);
      text.onChange((v) => (this.data.startDate = v || todayISO()));
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Criar parcelamento')
        .setCta()
        .onClick(() => {
          if (!this.data.description.trim()) {
            new Notice('Dê uma descrição para o parcelamento.');
            return;
          }
          if (!this.data.totalAmount || this.data.totalAmount <= 0) {
            new Notice('Informe um valor total maior que zero.');
            return;
          }
          this.onSubmit(this.data);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ReceivableModal extends Modal {
  constructor(app, accounts, onSubmit) {
    super(app);
    this.accounts = accounts;
    this.onSubmit = onSubmit;
    this.data = {
      description: '',
      totalAmount: 0,
      installmentsCount: 1,
      accountId: accounts[0] ? accounts[0].id : null,
      startDate: todayISO(),
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Novo valor a receber' });

    if (this.accounts.length === 0) {
      contentEl.createEl('p', { text: 'Crie uma conta primeiro.' });
      return;
    }

    new Setting(contentEl).setName('Descrição').setDesc('Ex: Cliente X, Reembolso, Freelance').addText((text) => {
      text.inputEl.focus();
      text.onChange((v) => (this.data.description = v));
    });

    new Setting(contentEl).setName('Valor total a receber (R$)').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '0.01';
      text.onChange((v) => (this.data.totalAmount = parseFloat(v) || 0));
    });

    new Setting(contentEl).setName('Em quantas parcelas').setDesc('Use 1 se for um valor único').addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.step = '1';
      text.setValue('1');
      text.onChange((v) => (this.data.installmentsCount = Math.max(1, parseInt(v) || 1)));
    });

    new Setting(contentEl).setName('Conta de destino').setDesc('Onde o dinheiro vai entrar').addDropdown((drop) => {
      this.accounts.forEach((a) => drop.addOption(a.id, a.name));
      drop.setValue(this.data.accountId);
      drop.onChange((v) => (this.data.accountId = v));
    });

    new Setting(contentEl).setName('Data prevista da 1ª parcela').addText((text) => {
      text.inputEl.type = 'date';
      text.setValue(this.data.startDate);
      text.onChange((v) => (this.data.startDate = v || todayISO()));
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Criar')
        .setCta()
        .onClick(() => {
          if (!this.data.description.trim()) {
            new Notice('Dê uma descrição.');
            return;
          }
          if (!this.data.totalAmount || this.data.totalAmount <= 0) {
            new Notice('Informe um valor total maior que zero.');
            return;
          }
          this.onSubmit(this.data);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ============================================================
   MAIN VIEW (sidebar)
   ============================================================ */

class WalletView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentTab = 'visao-geral';
    this.categoryFilter = 'todos';
    this.selectedMonthKey = null;
  }

  getViewType() {
    return VIEW_TYPE_WALLET;
  }

  getDisplayText() {
    return 'Carteira';
  }

  getIcon() {
    return 'wallet';
  }

  async onOpen() {
    this.render();
  }

  async onClose() {}

  get data() {
    return this.plugin.data;
  }

  async persist() {
    await this.plugin.saveData(this.plugin.data);
    this.render();
  }

  /* --------------------------- render root --------------------------- */

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('wallet-tracker-container');

    const header = container.createDiv({ cls: 'wt-header' });
    header.createEl('h3', { text: 'Carteira' });

    const tabs = container.createDiv({ cls: 'wt-tabs' });
    const tabDefs = [
      ['visao-geral', 'Visão Geral'],
      ['metas', 'Metas'],
      ['parcelamentos', 'Parcelamentos'],
      ['receber', 'A Receber'],
      ['contas', 'Contas'],
    ];
    tabDefs.forEach(([key, label]) => {
      const btn = tabs.createEl('button', {
        text: label,
        cls: key === this.currentTab ? 'wt-tab wt-tab-active' : 'wt-tab',
      });
      btn.onclick = () => {
        this.currentTab = key;
        this.render();
      };
    });

    const body = container.createDiv({ cls: 'wt-body' });

    if (this.currentTab === 'visao-geral') this.renderVisaoGeral(body);
    else if (this.currentTab === 'metas') this.renderMetas(body);
    else if (this.currentTab === 'parcelamentos') this.renderParcelamentos(body);
    else if (this.currentTab === 'receber') this.renderReceber(body);
    else if (this.currentTab === 'contas') this.renderContas(body);
  }

  /* --------------------------- VISÃO GERAL --------------------------- */

  renderVisaoGeral(body) {
    this.renderMonthAndCategoryFilters(body);
    this.renderDashboard(body);

    const btnRow = body.createDiv({ cls: 'wt-quick-actions' });
    const expenseBtn = btnRow.createEl('button', { text: 'Despesas', cls: 'wt-btn wt-btn-danger wt-btn-half' });
    expenseBtn.onclick = () => {
      new EntryModal(this.app, this.data.accounts, this.data.cards, 'despesa', async (d) => {
        await this.handleNewEntry(d, 'despesa');
      }).open();
    };

    const incomeBtn = btnRow.createEl('button', { text: 'Receitas', cls: 'wt-btn wt-btn-success wt-btn-half' });
    incomeBtn.onclick = () => {
      new EntryModal(this.app, this.data.accounts, this.data.cards, 'ganho', async (d) => {
        await this.handleNewEntry(d, 'ganho');
      }).open();
    };

    const transferBtn = body.createEl('button', { text: '⇄ Transferência entre contas', cls: 'wt-btn wt-btn-transfer' });
    transferBtn.onclick = () => {
      new TransferModal(this.app, this.data.accounts, async (t) => {
        await this.handleNewTransfer(t);
      }).open();
    };

    this.renderMonthList(body);
  }

  async handleNewEntry(d, txType) {
    const card = txType === 'despesa' ? this.data.cards.find((c) => c.id === d.accountId) : null;

    if (d.tipo === 'parcelamento') {
      const installmentAmount = d.amount / d.installmentsCount;
      if (txType === 'despesa' && card) {
        // Cartão: as parcelas caem sozinhas na fatura de cada mês seguinte.
        for (let i = 0; i < d.installmentsCount; i++) {
          addCardCharge(this.data, card.id, {
            amount: installmentAmount,
            description: `${d.description} (parcela ${i + 1}/${d.installmentsCount})`,
            category: d.category,
            date: addMonthsISO(d.date, i),
          });
        }
      } else if (txType === 'despesa') {
        this.data.installments.push({
          id: uid(),
          description: d.description,
          totalAmount: d.amount,
          installmentsCount: d.installmentsCount,
          installmentAmount,
          accountId: d.accountId,
          category: d.category,
          startDate: d.date,
          paidCount: 0,
        });
      } else {
        this.data.receivables.push({
          id: uid(),
          description: d.description,
          totalAmount: d.amount,
          installmentsCount: d.installmentsCount,
          installmentAmount,
          accountId: d.accountId,
          category: d.category,
          startDate: d.date,
          receivedCount: 0,
        });
      }
    } else if (d.tipo === 'recorrente') {
      const recurrenceId = uid();
      this.data.recurrences.push({
        id: recurrenceId,
        description: d.description,
        amount: d.amount,
        type: txType,
        accountId: d.accountId,
        category: d.category,
        startDate: d.date,
        lastGeneratedDate: d.date,
        active: true,
      });
      if (card) {
        addCardCharge(this.data, card.id, {
          amount: d.amount,
          description: d.description,
          category: d.category,
          date: d.date,
          recurrenceId,
        });
      } else {
        this.addTransaction({
          accountId: d.accountId,
          type: txType,
          amount: d.amount,
          category: d.category,
          description: d.description,
          date: d.date,
          paid: d.paid,
          recurrenceId,
        });
      }
    } else if (card) {
      addCardCharge(this.data, card.id, {
        amount: d.amount,
        description: d.description,
        category: d.category,
        date: d.date,
      });
    } else {
      this.addTransaction({
        accountId: d.accountId,
        type: txType,
        amount: d.amount,
        category: d.category,
        description: d.description,
        date: d.date,
        paid: d.paid,
      });
    }
    await this.persist();
  }

  async handleNewTransfer(t) {
    const fromAcc = this.data.accounts.find((a) => a.id === t.fromAccountId);
    const toAcc = this.data.accounts.find((a) => a.id === t.toAccountId);
    if (fromAcc) fromAcc.balance -= t.amount;
    if (toAcc) toAcc.balance += t.amount;

    this.data.transfers.push({
      id: uid(),
      fromAccountId: t.fromAccountId,
      toAccountId: t.toAccountId,
      amount: t.amount,
      description: t.description || '',
      date: t.date || todayISO(),
    });

    await this.persist();
  }

  /* --------------------------- DASHBOARD --------------------------- */

  computeDashboard() {
    const saldoAtual = this.data.accounts.reduce((s, a) => s + a.balance, 0);
    const pendingIncome = this.data.transactions
      .filter((t) => t.type === 'ganho' && t.paid === false)
      .reduce((s, t) => s + t.amount, 0);
    const receivablesRemaining = this.data.receivables.reduce(
      (s, r) => s + Math.max(0, r.installmentsCount - r.receivedCount) * r.installmentAmount,
      0
    );
    const aReceber = pendingIncome + receivablesRemaining;
    const guardado = this.data.goals.reduce((s, g) => s + g.current, 0);
    return { saldoAtual, aReceber, guardado };
  }

  /* --------------------------- FILTRO DE MÊS / CATEGORIA --------------------------- */

  getSelectedMonthKey() {
    if (!this.selectedMonthKey) this.selectedMonthKey = todayISO().slice(0, 7);
    return this.selectedMonthKey;
  }

  shiftMonth(delta) {
    const [y, m] = this.getSelectedMonthKey().split('-').map(Number);
    const comp = addMonthsToCompetencia({ year: y, month: m }, delta);
    this.selectedMonthKey = `${comp.year}-${pad2(comp.month)}`;
    this.render();
  }

  formatMonthLabel(monthKey) {
    const names = [
      'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
    ];
    const [y, m] = monthKey.split('-').map(Number);
    return `${names[m - 1]} ${y}`;
  }

  // Builds the month picture: what's already real (transactions/invoices) plus
  // what's only a forecast (future installment parcels, unmaterialized
  // recurring occurrences) for the given YYYY-MM.
  computeMonthData(monthKey) {
    const [year, month] = monthKey.split('-').map(Number);

    const realTx = this.data.transactions.filter((t) => t.date.startsWith(monthKey));
    const realDespesas = realTx
      .filter((t) => t.type === 'despesa' && t.paid !== false)
      .reduce((s, t) => s + t.amount, 0);
    const realReceitas = realTx
      .filter((t) => t.type === 'ganho' && t.paid !== false)
      .reduce((s, t) => s + t.amount, 0);
    const pendingDespesaTx = realTx.filter((t) => t.type === 'despesa' && t.paid === false);
    const pendingDespesaSum = pendingDespesaTx.reduce((s, t) => s + t.amount, 0);

    const installmentItems = [];
    this.data.installments.forEach((inst) => {
      for (let i = inst.paidCount; i < inst.installmentsCount; i++) {
        const dueDate = addMonthsISO(inst.startDate, i);
        if (dueDate.startsWith(monthKey)) {
          installmentItems.push({
            description: `${inst.description} (parcela ${i + 1}/${inst.installmentsCount})`,
            amount: inst.installmentAmount,
            date: dueDate,
          });
        }
      }
    });
    const installmentsSum = installmentItems.reduce((s, i) => s + i.amount, 0);

    const cardInvoiceItems = [];
    this.data.invoices
      .filter((inv) => inv.competencia === monthKey && !inv.paid)
      .forEach((inv) => {
        const total = getInvoiceTotal(this.data, inv.id);
        if (total > 0) {
          const cardItem = this.data.cards.find((c) => c.id === inv.cardId);
          cardInvoiceItems.push({
            description: `Fatura ${cardItem ? cardItem.name : 'cartão'} (${monthKey})`,
            amount: total,
            date: inv.closingDate,
          });
        }
      });
    const cardInvoiceSum = cardInvoiceItems.reduce((s, i) => s + i.amount, 0);

    const recurringItems = [];
    this.data.recurrences.forEach((rule) => {
      if (!rule.active || rule.type !== 'despesa') return;
      const ruleDay = Number(rule.startDate.split('-')[2]);
      const day = clampDayOfMonth(year, month, ruleDay);
      const candidateDate = `${year}-${pad2(month)}-${pad2(day)}`;
      if (candidateDate < rule.startDate) return;

      const card = this.data.cards.find((c) => c.id === rule.accountId);
      const alreadyReal = card
        ? this.data.cardCharges.some((c) => c.recurrenceId === rule.id && c.date.startsWith(monthKey))
        : this.data.transactions.some((t) => t.recurrenceId === rule.id && t.date.startsWith(monthKey));

      if (!alreadyReal) {
        recurringItems.push({
          description: `${rule.description} (recorrente)`,
          amount: rule.amount,
          date: candidateDate,
          rule,
        });
      }
    });
    const recurringSum = recurringItems.reduce((s, i) => s + i.amount, 0);

    const aPagar = pendingDespesaSum + installmentsSum + cardInvoiceSum + recurringSum;
    const balanceamento = realReceitas - realDespesas;

    return {
      realDespesas,
      realReceitas,
      aPagar,
      balanceamento,
      realTx,
      pendingDespesaTx,
      installmentItems,
      cardInvoiceItems,
      recurringItems,
    };
  }

  renderMonthAndCategoryFilters(container) {
    const bar = container.createDiv({ cls: 'wt-filter-bar' });

    const monthNav = bar.createDiv({ cls: 'wt-month-nav' });
    const prevBtn = monthNav.createEl('button', { text: '◀', cls: 'wt-btn wt-btn-icon' });
    prevBtn.onclick = () => this.shiftMonth(-1);
    monthNav.createDiv({ text: this.formatMonthLabel(this.getSelectedMonthKey()), cls: 'wt-month-label' });
    const nextBtn = monthNav.createEl('button', { text: '▶', cls: 'wt-btn wt-btn-icon' });
    nextBtn.onclick = () => this.shiftMonth(1);

    const catRow = bar.createDiv({ cls: 'wt-category-filters' });
    const cats = [
      ['todos', 'Todos'],
      ['despesa', 'Despesas'],
      ['ganho', 'Receitas'],
      ['a_pagar', 'A pagar'],
    ];
    cats.forEach(([key, label]) => {
      const btn = catRow.createEl('button', {
        text: label,
        cls: key === this.categoryFilter ? 'wt-tab wt-tab-active' : 'wt-tab',
      });
      btn.onclick = () => {
        this.categoryFilter = key;
        this.render();
      };
    });
  }

  renderDashboard(container) {
    const g = this.computeDashboard();
    const md = this.computeMonthData(this.getSelectedMonthKey());
    const grid = container.createDiv({ cls: 'wt-dashboard' });

    const makeCard = (label, value, colorClass, full) => {
      const card = grid.createDiv({ cls: `wt-dcard ${colorClass}${full ? ' wt-dcard-full' : ''}` });
      card.createDiv({ text: label, cls: 'wt-dcard-label' });
      card.createDiv({ text: formatCurrency(value), cls: 'wt-dcard-value' });
    };

    makeCard('Saldo atual', g.saldoAtual, 'wt-c-neutral', true);
    makeCard('Receitas', md.realReceitas, 'wt-c-green');
    makeCard('Despesas', md.realDespesas, 'wt-c-red');
    makeCard('A receber', g.aReceber, 'wt-c-teal');
    makeCard('A pagar', md.aPagar, 'wt-c-orange');
    makeCard('Balanceamento geral', md.balanceamento, md.balanceamento >= 0 ? 'wt-c-green' : 'wt-c-red');
    makeCard('Guardado (metas)', g.guardado, 'wt-c-gold');
  }

  /* --------------------------- CONTAS --------------------------- */

  renderContas(body) {
    const btnRow = body.createDiv({ cls: 'wt-quick-actions' });
    const addAccBtn = btnRow.createEl('button', { text: '+ Nova conta', cls: 'wt-btn wt-btn-primary wt-btn-half' });
    addAccBtn.onclick = () => {
      new AccountModal(this.app, null, async (acc) => {
        this.data.accounts.push({ id: uid(), name: acc.name, balance: acc.balance, color: acc.color });
        await this.persist();
      }).open();
    };

    const addCardBtn = btnRow.createEl('button', { text: '+ Novo cartão', cls: 'wt-btn wt-btn-primary wt-btn-half' });
    addCardBtn.onclick = () => {
      new CardModal(this.app, null, async (c) => {
        this.data.cards.push({
          id: uid(),
          name: c.name,
          limit: c.limit,
          closingDay: c.closingDay,
          dueDay: c.dueDay,
          color: c.color,
        });
        await this.persist();
      }).open();
    };

    if (this.data.accounts.length === 0 && this.data.cards.length === 0) {
      body.createEl('p', { text: 'Nenhuma conta ou cartão cadastrado ainda.', cls: 'wt-empty' });
      return;
    }

    this.data.accounts.forEach((acc) => {
      const card = body.createDiv({ cls: 'wt-card' });
      card.style.borderLeft = `4px solid ${acc.color || 'var(--interactive-accent)'}`;
      const top = card.createDiv({ cls: 'wt-card-top' });
      top.createEl('strong', { text: acc.name });
      top.createDiv({ text: formatCurrency(acc.balance), cls: 'wt-balance' });

      const actions = card.createDiv({ cls: 'wt-actions' });

      const editBtn = actions.createEl('button', { text: 'Editar', cls: 'wt-btn' });
      editBtn.onclick = () => {
        new AccountModal(this.app, acc, async (updated) => {
          acc.name = updated.name;
          acc.balance = updated.balance;
          acc.color = updated.color;
          await this.persist();
        }).open();
      };

      const delBtn = actions.createEl('button', { text: 'Excluir', cls: 'wt-btn wt-btn-ghost' });
      delBtn.onclick = async () => {
        this.data.accounts = this.data.accounts.filter((a) => a.id !== acc.id);
        this.data.transactions = this.data.transactions.filter((t) => t.accountId !== acc.id);
        await this.persist();
      };
    });

    this.data.cards.forEach((cardItem) => {
      const cardEl = body.createDiv({ cls: 'wt-card' });
      cardEl.style.borderLeft = `4px solid ${cardItem.color || 'var(--interactive-accent)'}`;
      const top = cardEl.createDiv({ cls: 'wt-card-top' });
      top.createEl('strong', { text: `${cardItem.name} (cartão)` });
      top.createDiv({ text: `Limite: ${formatCurrency(cardItem.limit)}`, cls: 'wt-muted' });

      const todayCycle = computeInvoiceCycle(cardItem, todayISO());
      const currentInvoice = this.data.invoices.find(
        (inv) => inv.cardId === cardItem.id && inv.competencia === todayCycle.competencia
      );
      const currentTotal = currentInvoice ? getInvoiceTotal(this.data, currentInvoice.id) : 0;
      cardEl.createDiv({
        text: `Fatura atual: ${formatCurrency(currentTotal)} (fecha em ${formatDateBR(todayCycle.closingDate)})`,
        cls: 'wt-muted',
      });

      const otherInvoices = this.data.invoices
        .filter((inv) => inv.cardId === cardItem.id && inv.competencia !== todayCycle.competencia)
        .sort((a, b) => (a.competencia < b.competencia ? 1 : -1));

      if (otherInvoices.length > 0) {
        cardEl.createDiv({ text: 'Faturas', cls: 'wt-subheading' });
        otherInvoices.forEach((inv) => {
          const total = getInvoiceTotal(this.data, inv.id);
          const row = cardEl.createDiv({ cls: 'wt-invoice-row' });
          const left = row.createDiv();
          left.createDiv({ text: `${inv.competencia} — ${formatCurrency(total)}`, cls: 'wt-invoice-amount' });

          let statusText;
          if (inv.paid) {
            const payerAcc = this.data.accounts.find((a) => a.id === inv.paidFromAccountId);
            statusText = `Paga em ${formatDateBR(inv.paidDate)}${payerAcc ? ' via ' + payerAcc.name : ''}`;
          } else {
            statusText = `Vence em ${formatDateBR(inv.dueDate)} • aguardando pagamento`;
          }
          left.createDiv({ text: statusText, cls: 'wt-muted' });

          if (!inv.paid && total > 0) {
            const payBtn = row.createEl('button', { text: 'Pagar fatura', cls: 'wt-btn wt-btn-danger' });
            payBtn.onclick = () => {
              new PayInvoiceModal(this.app, this.data.accounts, total, async (res) => {
                const payAcc = this.data.accounts.find((a) => a.id === res.accountId);
                if (payAcc) payAcc.balance -= total;
                inv.paid = true;
                inv.paidDate = todayISO();
                inv.paidFromAccountId = res.accountId;
                this.addTransaction({
                  accountId: res.accountId,
                  type: 'despesa',
                  amount: total,
                  category: 'Fatura cartão',
                  description: `Fatura ${cardItem.name} (${inv.competencia})`,
                  date: todayISO(),
                  paid: true,
                });
                await this.persist();
              }).open();
            };
          }
        });
      }

      const cardActions = cardEl.createDiv({ cls: 'wt-actions' });
      const editCardBtn = cardActions.createEl('button', { text: 'Editar', cls: 'wt-btn' });
      editCardBtn.onclick = () => {
        new CardModal(this.app, cardItem, async (updated) => {
          cardItem.name = updated.name;
          cardItem.limit = updated.limit;
          cardItem.closingDay = updated.closingDay;
          cardItem.dueDay = updated.dueDay;
          cardItem.color = updated.color;
          await this.persist();
        }).open();
      };

      const delCardBtn = cardActions.createEl('button', { text: 'Excluir', cls: 'wt-btn wt-btn-ghost' });
      delCardBtn.onclick = async () => {
        this.data.cardCharges = this.data.cardCharges.filter((c) => c.cardId !== cardItem.id);
        this.data.invoices = this.data.invoices.filter((inv) => inv.cardId !== cardItem.id);
        this.data.cards = this.data.cards.filter((c) => c.id !== cardItem.id);
        await this.persist();
      };
    });
  }

  addTransaction(t) {
    const acc = this.data.accounts.find((a) => a.id === t.accountId);
    const paid = t.paid !== false;
    if (acc && paid) {
      if (t.type === 'despesa') acc.balance -= t.amount;
      else acc.balance += t.amount;
    }

    this.data.transactions.push({
      id: uid(),
      accountId: t.accountId,
      type: t.type,
      amount: t.amount,
      category: t.category || '',
      description: t.description || '',
      date: t.date || todayISO(),
      paid,
      recurrenceId: t.recurrenceId || null,
    });
  }

  async setTransactionPaid(t, value) {
    const currentlyPaid = t.paid !== false;
    if (value === currentlyPaid) return;
    const acc = this.data.accounts.find((a) => a.id === t.accountId);
    if (value) {
      if (acc) {
        if (t.type === 'despesa') acc.balance -= t.amount;
        else acc.balance += t.amount;
      }
      t.paid = true;
      t.date = todayISO();
    } else {
      if (acc) {
        if (t.type === 'despesa') acc.balance += t.amount;
        else acc.balance -= t.amount;
      }
      t.paid = false;
    }
    await this.persist();
  }

  /* --------------------------- METAS --------------------------- */

  renderMetas(body) {
    const addBtn = body.createEl('button', { text: '+ Nova meta', cls: 'wt-btn wt-btn-primary' });
    addBtn.onclick = () => {
      new GoalModal(this.app, this.data.accounts, async (g) => {
        this.data.goals.push({
          id: uid(),
          name: g.name,
          target: g.target,
          current: g.current,
          deadline: g.deadline,
          accountId: g.accountId,
        });
        await this.persist();
      }).open();
    };

    if (this.data.goals.length === 0) {
      body.createEl('p', { text: 'Nenhuma meta cadastrada ainda.', cls: 'wt-empty' });
      return;
    }

    this.data.goals.forEach((goal) => {
      const card = body.createDiv({ cls: 'wt-card' });
      const top = card.createDiv({ cls: 'wt-card-top' });
      top.createEl('strong', { text: goal.name });
      top.createDiv({
        text: `${formatCurrency(goal.current)} / ${formatCurrency(goal.target)}`,
        cls: 'wt-balance',
      });

      const pct = Math.min(100, Math.round((goal.current / goal.target) * 100));
      const barOuter = card.createDiv({ cls: 'wt-progress-outer' });
      const barInner = barOuter.createDiv({ cls: 'wt-progress-inner' });
      barInner.style.width = `${pct}%`;
      card.createDiv({ text: `${pct}% concluído`, cls: 'wt-muted' });

      if (goal.deadline) {
        card.createDiv({ text: `Prazo: ${formatDateBR(goal.deadline)}`, cls: 'wt-muted' });
      }

      const actions = card.createDiv({ cls: 'wt-actions' });
      const addValueBtn = actions.createEl('button', { text: 'Adicionar valor', cls: 'wt-btn wt-btn-success' });
      addValueBtn.onclick = () => {
        new GoalContributionModal(this.app, this.data.accounts, goal, async (res) => {
          goal.current += res.amount;
          if (res.accountId) {
            this.addTransaction({
              accountId: res.accountId,
              type: 'despesa',
              amount: res.amount,
              category: 'Meta',
              description: `Aporte para meta: ${goal.name}`,
              date: todayISO(),
            });
          }
          await this.persist();
        }).open();
      };

      const delBtn = actions.createEl('button', { text: 'Excluir', cls: 'wt-btn wt-btn-ghost' });
      delBtn.onclick = async () => {
        this.data.goals = this.data.goals.filter((g) => g.id !== goal.id);
        await this.persist();
      };
    });
  }

  /* --------------------------- PARCELAMENTOS --------------------------- */

  renderParcelamentos(body) {
    const addBtn = body.createEl('button', { text: '+ Novo parcelamento', cls: 'wt-btn wt-btn-primary' });
    addBtn.onclick = () => {
      new InstallmentModal(this.app, this.data.accounts, async (inst) => {
        const installmentAmount = inst.totalAmount / inst.installmentsCount;
        this.data.installments.push({
          id: uid(),
          description: inst.description,
          totalAmount: inst.totalAmount,
          installmentsCount: inst.installmentsCount,
          installmentAmount,
          accountId: inst.accountId,
          startDate: inst.startDate,
          paidCount: 0,
        });
        await this.persist();
      }).open();
    };

    if (this.data.installments.length === 0) {
      body.createEl('p', { text: 'Nenhum parcelamento cadastrado ainda.', cls: 'wt-empty' });
      return;
    }

    this.data.installments.forEach((inst) => {
      const done = inst.paidCount >= inst.installmentsCount;
      const card = body.createDiv({ cls: 'wt-card' });
      const top = card.createDiv({ cls: 'wt-card-top' });
      top.createEl('strong', { text: inst.description });
      top.createDiv({ text: formatCurrency(inst.installmentAmount) + '/parcela', cls: 'wt-balance' });

      card.createDiv({
        text: `Parcela ${Math.min(inst.paidCount + 1, inst.installmentsCount)} de ${inst.installmentsCount}${done ? ' — concluído' : ''}`,
        cls: 'wt-muted',
      });
      card.createDiv({ text: `Total: ${formatCurrency(inst.totalAmount)}`, cls: 'wt-muted' });

      const nextDate = addMonthsISO(inst.startDate, inst.paidCount);
      if (!done) {
        card.createDiv({ text: `Próxima parcela: ${formatDateBR(nextDate)}`, cls: 'wt-muted' });
      }

      const acc = this.data.accounts.find((a) => a.id === inst.accountId);
      card.createDiv({ text: `Conta: ${acc ? acc.name : '(conta removida)'}`, cls: 'wt-muted' });

      const actions = card.createDiv({ cls: 'wt-actions' });

      if (!done) {
        const payBtn = actions.createEl('button', { text: 'Pagar próxima parcela', cls: 'wt-btn wt-btn-danger' });
        payBtn.onclick = async () => {
          if (acc) {
            this.addTransaction({
              accountId: acc.id,
              type: 'despesa',
              amount: inst.installmentAmount,
              category: 'Parcelamento',
              description: `${inst.description} (parcela ${inst.paidCount + 1}/${inst.installmentsCount})`,
              date: nextDate,
            });
          } else {
            new Notice('A conta desse parcelamento foi removida; apenas a parcela será marcada como paga.');
          }
          inst.paidCount += 1;
          await this.persist();
        };
      }

      const delBtn = actions.createEl('button', { text: 'Excluir', cls: 'wt-btn wt-btn-ghost' });
      delBtn.onclick = async () => {
        this.data.installments = this.data.installments.filter((i) => i.id !== inst.id);
        await this.persist();
      };
    });
  }

  /* --------------------------- A RECEBER --------------------------- */

  renderReceber(body) {
    const addBtn = body.createEl('button', { text: '+ Novo valor a receber', cls: 'wt-btn wt-btn-primary' });
    addBtn.onclick = () => {
      new ReceivableModal(this.app, this.data.accounts, async (rec) => {
        const installmentAmount = rec.totalAmount / rec.installmentsCount;
        this.data.receivables.push({
          id: uid(),
          description: rec.description,
          totalAmount: rec.totalAmount,
          installmentsCount: rec.installmentsCount,
          installmentAmount,
          accountId: rec.accountId,
          startDate: rec.startDate,
          receivedCount: 0,
        });
        await this.persist();
      }).open();
    };

    const pendingIncomes = this.data.transactions.filter((t) => t.type === 'ganho' && t.paid === false);

    if (this.data.receivables.length === 0 && pendingIncomes.length === 0) {
      body.createEl('p', { text: 'Nenhum valor a receber cadastrado ainda.', cls: 'wt-empty' });
      return;
    }

    this.data.receivables.forEach((rec) => {
      const done = rec.receivedCount >= rec.installmentsCount;
      const card = body.createDiv({ cls: 'wt-card' });
      const top = card.createDiv({ cls: 'wt-card-top' });
      top.createEl('strong', { text: rec.description });
      top.createDiv({ text: formatCurrency(rec.installmentAmount) + '/parcela', cls: 'wt-balance' });

      card.createDiv({
        text: `Parcela ${Math.min(rec.receivedCount + 1, rec.installmentsCount)} de ${rec.installmentsCount}${done ? ' — concluído' : ''}`,
        cls: 'wt-muted',
      });
      card.createDiv({ text: `Total: ${formatCurrency(rec.totalAmount)}`, cls: 'wt-muted' });

      const nextDate = addMonthsISO(rec.startDate, rec.receivedCount);
      if (!done) {
        card.createDiv({ text: `Previsto para: ${formatDateBR(nextDate)}`, cls: 'wt-muted' });
      }

      const acc = this.data.accounts.find((a) => a.id === rec.accountId);
      card.createDiv({ text: `Conta destino: ${acc ? acc.name : '(conta removida)'}`, cls: 'wt-muted' });

      const actions = card.createDiv({ cls: 'wt-actions' });

      if (!done) {
        const receiveBtn = actions.createEl('button', { text: 'Receber próxima parcela', cls: 'wt-btn wt-btn-success' });
        receiveBtn.onclick = async () => {
          if (acc) {
            this.addTransaction({
              accountId: acc.id,
              type: 'ganho',
              amount: rec.installmentAmount,
              category: 'Recebimento',
              description: `${rec.description} (parcela ${rec.receivedCount + 1}/${rec.installmentsCount})`,
              date: nextDate,
            });
          } else {
            new Notice('A conta desse recebimento foi removida; apenas a parcela será marcada como recebida.');
          }
          rec.receivedCount += 1;
          await this.persist();
        };
      }

      const delBtn = actions.createEl('button', { text: 'Excluir', cls: 'wt-btn wt-btn-ghost' });
      delBtn.onclick = async () => {
        this.data.receivables = this.data.receivables.filter((r) => r.id !== rec.id);
        await this.persist();
      };
    });

    if (pendingIncomes.length > 0) {
      body.createEl('h4', { text: 'Lançamentos únicos pendentes', cls: 'wt-subheading' });
      pendingIncomes.forEach((t) => {
        const acc = this.data.accounts.find((a) => a.id === t.accountId);
        const card = body.createDiv({ cls: 'wt-card' });
        const top = card.createDiv({ cls: 'wt-card-top' });
        top.createEl('strong', { text: t.description || t.category || 'Recebimento' });
        top.createDiv({ text: formatCurrency(t.amount), cls: 'wt-balance wt-c-teal-text' });
        card.createDiv({
          text: `Conta: ${acc ? acc.name : '(conta removida)'} • Previsto: ${formatDateBR(t.date)}`,
          cls: 'wt-muted',
        });

        const actions = card.createDiv({ cls: 'wt-actions' });
        const receiveBtn = actions.createEl('button', { text: 'Marcar como recebido', cls: 'wt-btn wt-btn-success' });
        receiveBtn.onclick = async () => {
          await this.setTransactionPaid(t, true);
        };

        const delBtn2 = actions.createEl('button', { text: 'Excluir', cls: 'wt-btn wt-btn-ghost' });
        delBtn2.onclick = async () => {
          this.data.transactions = this.data.transactions.filter((x) => x.id !== t.id);
          await this.persist();
        };
      });
    }
  }

  /* --------------------------- HISTÓRICO --------------------------- */

  renderTransactionRow(body, t) {
    const acc = this.data.accounts.find((a) => a.id === t.accountId);
    const pending = t.paid === false;
    const row = body.createDiv({ cls: 'wt-history-row' });
    const left = row.createDiv();

    let amountCls;
    if (pending) amountCls = t.type === 'despesa' ? 'wt-hist-amount wt-hist-pending-neg' : 'wt-hist-amount wt-hist-pending-pos';
    else amountCls = t.type === 'despesa' ? 'wt-hist-amount wt-hist-neg' : 'wt-hist-amount wt-hist-pos';

    left.createDiv({
      text: `${t.type === 'despesa' ? '−' : '+'} ${formatCurrency(t.amount)}${pending ? (t.type === 'despesa' ? ' (a pagar)' : ' (a receber)') : ''}`,
      cls: amountCls,
    });
    left.createDiv({
      text: `${t.description || t.category || 'Sem descrição'} • ${acc ? acc.name : '(conta removida)'}`,
      cls: 'wt-muted',
    });
    left.createDiv({ text: formatDateBR(t.date), cls: 'wt-muted' });

    const right = row.createDiv({ cls: 'wt-hist-right' });

    new ToggleComponent(right)
      .setValue(t.paid !== false)
      .setTooltip(t.type === 'despesa' ? 'Pago' : 'Recebido')
      .onChange(async (value) => {
        await this.setTransactionPaid(t, value);
      });

    const delBtn = right.createEl('button', { text: '✕', cls: 'wt-btn wt-btn-ghost wt-hist-del' });
    delBtn.onclick = async () => {
      if (t.recurrenceId) {
        new ConfirmRecurrenceDeleteModal(
          this.app,
          async () => {
            if (t.paid !== false && acc) {
              if (t.type === 'despesa') acc.balance += t.amount;
              else acc.balance -= t.amount;
            }
            this.data.transactions = this.data.transactions.filter((x) => x.id !== t.id);
            await this.persist();
          },
          async () => {
            this.data.transactions
              .filter((x) => x.recurrenceId === t.recurrenceId)
              .forEach((x) => {
                const a = this.data.accounts.find((acc2) => acc2.id === x.accountId);
                if (a && x.paid !== false) {
                  if (x.type === 'despesa') a.balance += x.amount;
                  else a.balance -= x.amount;
                }
              });
            this.data.transactions = this.data.transactions.filter((x) => x.recurrenceId !== t.recurrenceId);
            this.data.recurrences = this.data.recurrences.filter((r) => r.id !== t.recurrenceId);
            await this.persist();
          }
        ).open();
      } else {
        if (acc && t.paid !== false) {
          if (t.type === 'despesa') acc.balance += t.amount;
          else acc.balance -= t.amount;
        }
        this.data.transactions = this.data.transactions.filter((x) => x.id !== t.id);
        await this.persist();
      }
    };
  }

  renderProjectedRow(body, item) {
    const row = body.createDiv();
    row.addClass('wt-history-row');
    row.addClass('wt-history-projected');
    const left = row.createDiv();
    left.createDiv({ text: `− ${formatCurrency(item.amount)}`, cls: 'wt-hist-amount wt-hist-pending-neg' });
    left.createDiv({ text: `${item.description} • previsto`, cls: 'wt-muted' });
    left.createDiv({ text: formatDateBR(item.date), cls: 'wt-muted' });

    if (item.rule) {
      const right = row.createDiv({ cls: 'wt-hist-right' });
      new ToggleComponent(right)
        .setValue(false)
        .setTooltip('Confirmar pagamento antecipado')
        .onChange(async (value) => {
          if (!value) return;
          generateRecurringOccurrence(this.data, item.rule, item.date);
          if (item.date > item.rule.lastGeneratedDate) {
            item.rule.lastGeneratedDate = item.date;
          }
          await this.persist();
        });
    }
  }

  renderMonthList(body) {
    const monthKey = this.getSelectedMonthKey();
    const md = this.computeMonthData(monthKey);
    const filter = this.categoryFilter;

    const rows = [];

    if (filter === 'todos' || filter === 'despesa') {
      md.realTx
        .filter((t) => t.type === 'despesa' && t.paid !== false)
        .forEach((t) => rows.push({ kind: 'tx', date: t.date, data: t }));
    }
    if (filter === 'todos' || filter === 'ganho') {
      md.realTx
        .filter((t) => t.type === 'ganho' && t.paid !== false)
        .forEach((t) => rows.push({ kind: 'tx', date: t.date, data: t }));
    }
    if (filter === 'todos' || filter === 'a_pagar') {
      md.pendingDespesaTx.forEach((t) => rows.push({ kind: 'tx', date: t.date, data: t }));
      md.installmentItems.forEach((i) => rows.push({ kind: 'projected', date: i.date, data: i }));
      md.cardInvoiceItems.forEach((i) => rows.push({ kind: 'projected', date: i.date, data: i }));
      md.recurringItems.forEach((i) => rows.push({ kind: 'projected', date: i.date, data: i }));
    }
    if (filter === 'todos') {
      this.data.transfers
        .filter((tr) => tr.date.startsWith(monthKey))
        .forEach((tr) => rows.push({ kind: 'transfer', date: tr.date, data: tr }));
    }

    if (rows.length === 0) {
      body.createEl('p', { text: `Nada por aqui em ${this.formatMonthLabel(monthKey)}.`, cls: 'wt-empty' });
      return;
    }

    rows
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .forEach((r) => {
        if (r.kind === 'tx') this.renderTransactionRow(body, r.data);
        else if (r.kind === 'transfer') this.renderTransferRow(body, r.data);
        else this.renderProjectedRow(body, r.data);
      });
  }

  renderTransferRow(body, tr) {
    const fromAcc = this.data.accounts.find((a) => a.id === tr.fromAccountId);
    const toAcc = this.data.accounts.find((a) => a.id === tr.toAccountId);
    const row = body.createDiv({ cls: 'wt-history-row' });
    const left = row.createDiv();
    left.createDiv({ text: `⇄ ${formatCurrency(tr.amount)}`, cls: 'wt-hist-amount wt-hist-transfer' });
    left.createDiv({
      text: `${tr.description ? tr.description + ' • ' : ''}${fromAcc ? fromAcc.name : '(conta removida)'} → ${
        toAcc ? toAcc.name : '(conta removida)'
      }`,
      cls: 'wt-muted',
    });
    left.createDiv({ text: formatDateBR(tr.date), cls: 'wt-muted' });

    const right = row.createDiv({ cls: 'wt-hist-right' });
    const delBtn = right.createEl('button', { text: '✕', cls: 'wt-btn wt-btn-ghost wt-hist-del' });
    delBtn.onclick = async () => {
      if (fromAcc) fromAcc.balance += tr.amount;
      if (toAcc) toAcc.balance -= tr.amount;
      this.data.transfers = this.data.transfers.filter((x) => x.id !== tr.id);
      await this.persist();
    };
  }
}

/* ============================================================
   PLUGIN ENTRY POINT
   ============================================================ */

module.exports = class WalletTrackerPlugin extends Plugin {
  async onload() {
    this.data = Object.assign(emptyData(), await this.loadData());

    const changed = processRecurrences(this.data);
    if (changed) await this.saveData(this.data);

    this.registerView(VIEW_TYPE_WALLET, (leaf) => new WalletView(leaf, this));

    this.addRibbonIcon('wallet', 'Abrir Carteira', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-wallet-tracker',
      name: 'Abrir Carteira',
      callback: () => this.activateView(),
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_WALLET);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_WALLET);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_WALLET, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};
