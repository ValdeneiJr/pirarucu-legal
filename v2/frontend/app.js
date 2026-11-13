// Pirarucu Legal - lógica do frontend: conexão com a MetaMask, leitura (.call),
// escrita (.send), eventos e tratamento de erros do contrato.
//
// Organização do arquivo:
//   1. Configuração e estado
//   2. Início e provedores (window.ethereum + RPC público)
//   3. Conectar carteira, trocar de rede e reagir a mudanças na MetaMask
//   4. Leitura com .call() (gratuita)
//   5. Eventos com getPastEvents (histórico)
//   6. Escrita com .send() (transações, incluindo envio de ETH)
//   7. Tela (renderização dos painéis, peixes e eventos)
//   8. Tratamento de erros (rejeição, erros personalizados, falta de saldo)
//   9. Utilitários
"use strict";

// =====================================================================
// 1) CONFIGURAÇÃO E ESTADO
// ---------------------------------------------------------------------
// O Web3.js precisa de duas coisas para falar com o contrato:
//   - o ENDEREÇO (onde ele está na Sepolia) e
//   - a ABI (como codificar as chamadas e decodificar respostas e logs).
// Os dois ficam em contrato.js (objeto CONTRATO). A rede, os textos dos
// enums e os limites ficam em constantes.js. Se o contrato for alterado e
// reimplantado, atualize endereço, ABI e blocoDeploy em contrato.js.
//
// Há dois objetos Contract:
//   - contratoLeitura: usado nas leituras (.call) e nos eventos. Usa a
//     MetaMask se ela estiver na Sepolia; senão, um RPC público, para que
//     o consumidor consulte um lacre sem ter carteira.
//   - contratoCarteira: usado nas transações (.send). Sempre pela MetaMask,
//     que guarda a chave privada e assina; o frontend nunca vê a chave.
// =====================================================================

const estado = {
  web3Leitura: null,
  contratoLeitura: null,
  web3Carteira: null,
  contratoCarteira: null,
  conta: null,
  naSepolia: false,
  fiscalizador: null,
  papel: 0,
  nome: "",
  ativo: true, // false = conta suspensa pelo fiscalizador principal
  peixes: [],
  eventos: [],
  ultimoBlocoEventos: null,
  participantes: new Map(), // endereço (minúsculo) -> { nome, papel, ativo }
};

const $ = (id) => document.getElementById(id);
let abiUtil = null;
let seletoresDeErro = new Map();

// =====================================================================
// 2) INÍCIO E PROVEDORES
// ---------------------------------------------------------------------
// A MetaMask injeta window.ethereum (provider EIP-1193) em páginas
// servidas por HTTP/HTTPS. Ao abrir a página:
//   1. confere se a Web3.js carregou do CDN;
//   2. monta o mapa de seletores dos erros personalizados (seção 8);
//   3. se a MetaMask existe, registra os ouvintes de troca de conta e
//      de rede e usa eth_accounts, que devolve as contas já autorizadas
//      SEM abrir o popup (reconexão silenciosa);
//   4. escolhe o provedor de leitura e carrega os dados do contrato.
// =====================================================================

window.addEventListener("load", iniciar);

async function iniciar() {
  if (typeof Web3 === "undefined") {
    aviso("Não foi possível carregar a Web3.js. Verifique a conexão com a internet.");
    return;
  }
  abiUtil = new Web3().eth.abi;
  seletoresDeErro = montarSeletoresDeErro(CONTRATO.abi);
  ligarEventosDaTela();

  $("avisoContrato").hidden = contratoConfigurado();
  if (contratoConfigurado()) {
    $("linkContrato").textContent = curto(CONTRATO.endereco);
    $("linkContrato").href = `${SEPOLIA.explorer}/address/${CONTRATO.endereco}`;
  }

  if (window.ethereum) {
    estado.web3Carteira = new Web3(window.ethereum);
    window.ethereum.on("accountsChanged", aoTrocarConta);
    window.ethereum.on("chainChanged", aoTrocarRede);
    // Se o site já foi autorizado antes, reconecta sem abrir a MetaMask
    const contas = await window.ethereum.request({ method: "eth_accounts" });
    estado.conta = contas[0] || null;
    await verificarRede();
  } else {
    $("avisoMetaMask").hidden = false;
  }

  configurarProvedores();
  await atualizarTudo();
}

function contratoConfigurado() {
  return typeof CONTRATO !== "undefined" && CONTRATO.endereco && CONTRATO.endereco !== ENDERECO_ZERO;
}

// Leitura: pela MetaMask quando ela está na Sepolia; senão, por um RPC público
// (assim qualquer pessoa consulta os peixes mesmo sem carteira).
function configurarProvedores() {
  const usarCarteira = estado.web3Carteira && estado.naSepolia;
  estado.web3Leitura = usarCarteira ? estado.web3Carteira : new Web3(SEPOLIA.rpcPublico);
  if (!contratoConfigurado()) return;
  estado.contratoLeitura = new estado.web3Leitura.eth.Contract(CONTRATO.abi, CONTRATO.endereco);
  if (estado.web3Carteira) {
    estado.contratoCarteira = new estado.web3Carteira.eth.Contract(CONTRATO.abi, CONTRATO.endereco);
  }
}

function ligarEventosDaTela() {
  $("btnConectar").addEventListener("click", conectar);
  $("btnTrocarRede").addEventListener("click", trocarParaSepolia);
  $("btnAtualizar").addEventListener("click", () => atualizarTudo());
  $("filtroPeixes").addEventListener("change", renderizarPeixes);
  $("btnSacar").addEventListener("click", sacarTudo);
  $("formConsulta").addEventListener("submit", consultarLacre);
  ligarFormularios();
  $("formAutorizar").elements.adultos.addEventListener("input", (e) => {
    const n = Number(e.target.value);
    $("previaCota").textContent = n > 0
      ? `Cota: ${Math.floor((n * PERCENTUAL_COTA) / 100)} peixe(s) (${PERCENTUAL_COTA}% de ${n}).`
      : `A cota é ${PERCENTUAL_COTA}% dos adultos contados.`;
  });
  const lacre = $("formCaptura").elements.lacre;
  lacre.addEventListener("input", () => { lacre.value = lacre.value.toUpperCase(); });
}

// =====================================================================
// 3) CONECTAR CARTEIRA, REDE E MUDANÇAS NA METAMASK
// ---------------------------------------------------------------------
// conectar(): eth_requestAccounts (EIP-1102) abre o popup da MetaMask
//   pedindo permissão. Se o usuário recusar, o erro tem código 4001.
// verificarRede(): eth_chainId diz em que rede a carteira está. O contrato
//   só existe na Sepolia (11155111 = 0xaa36a7); em outra rede, o mesmo
//   endereço aponta para nada.
// trocarParaSepolia(): wallet_switchEthereumChain (EIP-3326). Se a rede
//   não estiver cadastrada na MetaMask (código 4902), adiciona com
//   wallet_addEthereumChain (EIP-3085).
// aoTrocarConta() / aoTrocarRede(): o provider emite accountsChanged e
//   chainChanged. Sem tratá-los, a variável "conta" ficaria desatualizada
//   e a próxima transação sairia da conta errada. Em vez de recarregar a
//   página, atualizamos o estado e a tela: o painel muda sozinho conforme
//   o papel da nova conta (fiscalizador, comunidade, frigorífico, mercado).
// =====================================================================

async function conectar() {
  if (!window.ethereum) {
    toast("Instale a MetaMask para conectar a carteira.", true);
    return;
  }
  try {
    const contas = await window.ethereum.request({ method: "eth_requestAccounts" });
    estado.conta = contas[0] || null;
    await verificarRede();
    if (!estado.naSepolia) toast("Conectado. Agora troque a rede para Sepolia.", true);
    configurarProvedores();
    await atualizarTudo();
  } catch (e) {
    toast(mensagemDeErro(e), true);
  }
}

async function verificarRede() {
  if (!window.ethereum) return;
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  estado.naSepolia = String(chainId).toLowerCase() === SEPOLIA.chainId;
  $("avisoRede").hidden = estado.naSepolia;
  const selo = $("rede");
  selo.textContent = estado.naSepolia ? "Sepolia" : `rede errada (${parseInt(chainId, 16)})`;
  selo.className = `selo ${estado.naSepolia ? "ok" : "erro"}`;
}

async function trocarParaSepolia() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA.chainId }],
    });
  } catch (e) {
    if (e.code === 4902) {
      // A Sepolia não está cadastrada na MetaMask: adiciona
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: SEPOLIA.chainId,
            chainName: "Sepolia",
            nativeCurrency: { name: "SepoliaETH", symbol: "ETH", decimals: 18 },
            rpcUrls: [SEPOLIA.rpcPublico],
            blockExplorerUrls: [SEPOLIA.explorer],
          }],
        });
      } catch (e2) {
        toast(mensagemDeErro(e2), true);
      }
    } else {
      toast(mensagemDeErro(e), true);
    }
  }
}

async function aoTrocarConta(contas) {
  estado.conta = contas[0] || null;
  toast(estado.conta ? `Conta trocada: ${curto(estado.conta)}` : "Carteira desconectada.");
  await atualizarTudo();
}

async function aoTrocarRede() {
  await verificarRede();
  configurarProvedores();
  await atualizarTudo();
}

// =====================================================================
// 4) LEITURA COM .call() - NÃO GERA TRANSAÇÃO NEM CUSTA GAS
// ---------------------------------------------------------------------
// .call() vira um eth_call: o nó executa a função sobre o estado atual e
// devolve o resultado, sem assinatura e sem alterar a blockchain. Serve
// para funções view/pure e para os getters automáticos das variáveis
// public (fiscalizador(), saldos(conta), participantes(conta), cotas(...)).
//
// Detalhes:
//   - Promise.all dispara leituras independentes em paralelo.
//   - Na Web3.js v4, uint256 volta como BigInt. Valores em wei ficam em
//     BigInt (Number perde precisão acima de 2^53); só medidas pequenas
//     (cm, gramas, id) são convertidas com Number em normalizarPeixe().
//   - listarPeixes() é paginada (no máximo 50 por chamada, limite do
//     próprio contrato), por isso carregarPeixes() busca em páginas.
//   - Structs voltam como objeto com os campos por nome (p.lacre, p.dono...).
// =====================================================================

async function atualizarTudo() {
  try {
    await atualizarConta();
    if (contratoConfigurado()) {
      await Promise.all([carregarResumo(), carregarPeixes(), carregarEventos()]);
      await atualizarPapel();
    }
  } catch (e) {
    console.error(e);
    toast(`Não foi possível ler o contrato: ${mensagemDeErro(e)}`, true);
  }
  renderizarPaineis();
  renderizarPeixes();
  renderizarEventos();
}

async function atualizarConta() {
  const conectado = Boolean(estado.conta);
  $("infoConta").hidden = !conectado;
  $("btnConectar").hidden = conectado;
  if (!conectado) {
    estado.papel = 0;
    return;
  }
  $("endereco").textContent = curto(estado.conta);
  $("endereco").href = `${SEPOLIA.explorer}/address/${estado.conta}`;
  const saldo = await estado.web3Carteira.eth.getBalance(estado.conta);
  $("saldoEth").textContent = `${eth(saldo)} ETH`;
}

async function atualizarPapel() {
  estado.papel = 0;
  estado.nome = "";
  estado.ativo = true;
  const selo = $("papel");
  if (!estado.conta) return;
  if (ePrincipal()) {
    selo.textContent = "Fiscalizador principal (dono)";
    selo.className = "selo fiscal";
    return;
  }
  const p = await estado.contratoLeitura.methods.participantes(estado.conta).call();
  estado.papel = Number(p.papel);
  estado.nome = p.nome;
  estado.ativo = Boolean(p.ativo);
  if (!estado.papel) {
    selo.textContent = "Sem papel";
    selo.className = "selo";
    return;
  }
  selo.textContent = `${PAPEIS[estado.papel]} · ${p.nome}${estado.ativo ? "" : " (suspenso)"}`;
  selo.className = `selo${!estado.ativo ? " erro" : estado.papel === PAPEL_FISCALIZADOR ? " fiscal" : ""}`;
}

async function carregarResumo() {
  const c = estado.contratoLeitura.methods;
  const [total, negociado, fiscal] = await Promise.all([
    c.totalPeixes().call(),
    c.totalNegociadoWei().call(),
    c.fiscalizador().call(),
  ]);
  estado.fiscalizador = fiscal;
  $("totalPeixes").textContent = String(total);
  $("totalNegociado").textContent = eth(negociado);
  $("linkFiscal").textContent = curto(fiscal);
  $("linkFiscal").href = `${SEPOLIA.explorer}/address/${fiscal}`;
}

async function carregarPeixes() {
  const c = estado.contratoLeitura.methods;
  const total = Number(await c.totalPeixes().call());
  const peixes = [];
  // Busca em páginas, como o contrato limita cada chamada a 50 peixes
  for (let inicio = 0; inicio < total; inicio += POR_PAGINA) {
    const pagina = await c.listarPeixes(inicio, POR_PAGINA).call();
    pagina.forEach((p) => peixes.push(normalizarPeixe(p)));
  }
  estado.peixes = peixes;
}

function normalizarPeixe(p) {
  return {
    id: Number(p.id),
    lacre: p.lacre,
    comunidade: p.comunidade,
    dono: p.dono,
    comprimentoCm: Number(p.comprimentoCm),
    pesoGramas: Number(p.pesoGramas),
    local: p.local,
    temperaturaC: Number(p.temperaturaC),
    armazenado: Boolean(p.armazenado),
    preco: BigInt(p.preco),
    etapa: Number(p.etapa),
    capturadoEm: Number(p.capturadoEm),
  };
}

// =====================================================================
// 5) EVENTOS COM getPastEvents - HISTÓRICO LIDO DOS LOGS
// ---------------------------------------------------------------------
// Cada "emit" no contrato grava um log no recibo da transação. Os logs não
// ficam no storage (o contrato não consegue lê-los), mas os nós os indexam
// e qualquer um pode consultá-los de fora. Eles formam o histórico público
// de cada peixe (a linha do tempo na consulta por lacre).
//
// Detalhes de carregarEventos():
//   - "allEvents" traz todos os 10 eventos do contrato de uma vez; a ABI
//     decodifica os argumentos em ev.returnValues.
//   - Começa no bloco do deploy (CONTRATO.blocoDeploy), e não no bloco 0.
//   - RPCs públicos limitam o intervalo de eth_getLogs, então a busca é
//     feita em lotes de PASSO_EVENTOS blocos.
//   - Guarda o último bloco lido: nas próximas atualizações, busca só os
//     blocos novos.
//   - Os eventos ParticipanteCadastrado e ParticipanteAtivoAlterado alimentam
//     o mapa endereço -> { nome, papel, ativo }, usado para mostrar
//     "Comunidade X" em vez de 0x1234…abcd e para esconder a compra de
//     peixes de vendedores suspensos.
// =====================================================================
async function carregarEventos() {
  const atual = Number(await estado.web3Leitura.eth.getBlockNumber());
  let de;
  if (estado.ultimoBlocoEventos !== null) de = estado.ultimoBlocoEventos + 1;
  else if (CONTRATO.blocoDeploy > 0) de = CONTRATO.blocoDeploy;
  else de = Math.max(0, atual - JANELA_SEM_BLOCO_DEPLOY);
  if (de > atual) return;

  const novos = [];
  for (let inicio = de; inicio <= atual; inicio += PASSO_EVENTOS) {
    const fim = Math.min(inicio + PASSO_EVENTOS - 1, atual);
    const lote = await estado.contratoLeitura.getPastEvents("allEvents", { fromBlock: inicio, toBlock: fim });
    novos.push(...lote);
  }
  for (const ev of novos) {
    const v = ev.returnValues;
    if (ev.event === "ParticipanteCadastrado") {
      estado.participantes.set(v.conta.toLowerCase(), { nome: v.nome, papel: Number(v.papel), ativo: true });
    } else if (ev.event === "ParticipanteAtivoAlterado") {
      const p = estado.participantes.get(v.conta.toLowerCase());
      if (p) p.ativo = Boolean(v.ativo);
    }
  }
  estado.eventos.push(...novos);
  estado.ultimoBlocoEventos = atual;
}

// =====================================================================
// 6) ESCRITA COM .send() - TRANSAÇÕES ASSINADAS NA METAMASK
// ---------------------------------------------------------------------
// Alterar o estado do contrato exige uma transação: assinada pela chave
// privada da conta, incluída num bloco e paga em gas. Todas as escritas
// passam por enviar(), que segue este ciclo:
//   1. prontoParaEnviar(): carteira instalada, conectada e na Sepolia.
//   2. Simulação com .call({ from }): se o contrato for dar revert, o erro
//      aparece aqui, com a mensagem certa, sem abrir a MetaMask nem
//      gastar gas.
//   3. estimateGas + 20% de folga (FOLGA_GAS_PERCENTUAL).
//   4. .send({ from, value, gas }): a MetaMask abre para assinar.
//      - "value" só existe em comprar(): é o ETH enviado junto (payable).
//      - Evento "transactionHash": a transação entrou no mempool e já
//        tem hash (link do Etherscan), mas ainda não foi minerada.
//      - A Promise resolve com o recibo quando entra num bloco.
//   5. A lista "Transações" mostra os estados: aguardando assinatura ->
//      pendente -> confirmada (ou falhou, com o motivo).
//   6. Recarrega os dados. O botão fica desabilitado durante o envio,
//      para evitar transações duplicadas.
// =====================================================================

function prontoParaEnviar() {
  if (!window.ethereum) return falhar("Instale a MetaMask para enviar transações.");
  if (!estado.conta) return falhar("Conecte a carteira primeiro.");
  if (!estado.naSepolia) {
    $("avisoRede").hidden = false;
    return falhar("Troque a rede da MetaMask para Sepolia.");
  }
  if (!contratoConfigurado()) return falhar("O endereço do contrato não foi configurado.");
  return true;
}

function falhar(msg) {
  toast(msg, true);
  return false;
}

/**
 * Envia uma transação: simula com .call() (para mostrar o erro do contrato antes
 * de abrir a MetaMask), envia com .send() e acompanha o estado na lista.
 */
async function enviar(descricao, metodo, valorWei = 0n, botao = null) {
  if (!prontoParaEnviar()) return false;
  const opcoes = { from: estado.conta };
  if (valorWei > 0n) opcoes.value = valorWei.toString();

  if (botao) botao.disabled = true;
  const item = adicionarTx(descricao);
  try {
    await metodo.call(opcoes); // simulação: se o contrato for recusar, recusa aqui sem gastar gas
    const gas = await metodo.estimateGas(opcoes);
    opcoes.gas = ((BigInt(gas) * (100n + FOLGA_GAS_PERCENTUAL)) / 100n).toString(); // estimativa + folga
  } catch (e) {
    atualizarTx(item, "falhou", null, mensagemDeErro(e));
    toast(mensagemDeErro(e), true);
    if (botao) botao.disabled = false;
    return false;
  }

  try {
    const recibo = await metodo
      .send(opcoes)
      .on("transactionHash", (hash) => atualizarTx(item, "pendente", hash));
    atualizarTx(item, "confirmada", recibo.transactionHash);
    toast(`${descricao}: confirmada no bloco ${recibo.blockNumber}.`);
    await atualizarTudo();
    return true;
  } catch (e) {
    console.error(e);
    atualizarTx(item, "falhou", hashDoErro(e), mensagemDeErro(e));
    toast(mensagemDeErro(e), true);
    return false;
  } finally {
    if (botao) botao.disabled = false;
  }
}

// Métodos do contrato pela carteira (para .send)
function metodos() {
  return estado.contratoCarteira.methods;
}

// Cada formulário monta [descrição, método]; se a validação falhar, mostra o
// aviso e devolve null. Depois de confirmada, o formulário é limpo.
function ligarFormulario(id, montar) {
  $(id).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    if (!prontoParaEnviar()) return;
    const tx = montar(f.elements);
    if (Array.isArray(tx) && await enviar(tx[0], tx[1], 0n, f.querySelector("button"))) f.reset();
  });
}

function ligarFormularios() {
  ligarFormulario("formCadastrar", (e) => {
    const conta = e.conta.value.trim();
    if (!Web3.utils.isAddress(conta)) {
      toast("Endereço de carteira inválido.", true);
      return null;
    }
    const papel = Number(e.papel.value);
    const nome = e.nome.value.trim();
    return [`Cadastrar ${PAPEIS[papel]} "${nome}"`, metodos().cadastrarParticipante(conta, papel, nome)];
  });

  ligarFormulario("formAutorizar", (e) => {
    const comunidade = e.comunidade.value.trim();
    if (!Web3.utils.isAddress(comunidade)) {
      toast("Endereço da comunidade inválido.", true);
      return null;
    }
    const adultos = e.adultos.value;
    return [`Autorizar manejo (${adultos} adultos)`, metodos().autorizarManejo(comunidade, adultos)];
  });

  ligarFormulario("formAtivo", (e) => {
    const conta = e.conta.value.trim();
    if (!Web3.utils.isAddress(conta)) {
      toast("Endereço de carteira inválido.", true);
      return null;
    }
    const reativar = e.acao.value === "reativar";
    return [`${reativar ? "Reativar" : "Suspender"} ${nomeDe(conta)}`, metodos().definirAtivo(conta, reativar)];
  });

  ligarFormulario("formApreender", (e) => [
    `Apreender peixe #${e.idPeixe.value}`,
    metodos().apreender(e.idPeixe.value, e.motivo.value.trim()),
  ]);

  ligarFormulario("formCaptura", (e) => {
    const lacre = e.lacre.value.trim().toUpperCase();
    const cm = Math.round(Number(e.comprimento.value) * 100);
    const gramas = Math.round(Number(e.peso.value) * 1000);
    return [`Registrar peixe ${lacre}`, metodos().registrarCaptura(lacre, cm, gramas, e.local.value.trim())];
  });
}

async function sacarTudo() {
  const saldo = await estado.contratoLeitura.methods.saldos(estado.conta).call();
  if (BigInt(saldo) === 0n) return toast("Você não tem saldo de vendas para sacar.", true);
  await enviar(`Sacar ${eth(saldo)} ETH`, metodos().sacar(saldo), 0n, $("btnSacar"));
}

async function consultarLacre(ev) {
  ev.preventDefault();
  const lacre = ev.target.elements.lacre.value.trim().toUpperCase();
  const saida = $("resultadoConsulta");
  saida.replaceChildren(el("p", { class: "vazio" }, "Consultando…"));
  if (!contratoConfigurado()) {
    saida.replaceChildren(el("p", { class: "vazio" }, "Contrato não configurado."));
    return;
  }
  try {
    const peixe = normalizarPeixe(await estado.contratoLeitura.methods.consultarPorLacre(lacre).call());
    const historico = estado.eventos.filter(
      (e) => e.returnValues && e.returnValues.id !== undefined && Number(e.returnValues.id) === peixe.id,
    );
    saida.replaceChildren(
      el("div", { class: "resultado" },
        el("h3", {}, `Lacre ${peixe.lacre} · peixe #${peixe.id}`),
        detalhesPeixe(peixe),
        el("h4", {}, "Caminho do peixe"),
        historico.length
          ? el("ul", { class: "linha-tempo" }, ...historico.map((e) =>
            el("li", {}, descreverEvento(e), " ", linkTx(e.transactionHash, "ver no Etherscan"))))
          : el("p", { class: "vazio" }, "Nenhum evento encontrado no histórico carregado."),
      ),
    );
  } catch (e) {
    saida.replaceChildren(el("p", { class: "vazio" }, mensagemDeErro(e)));
  }
}

// =====================================================================
// 7) TELA
// ---------------------------------------------------------------------
// A interface se adapta ao papel da conta conectada: só aparecem os
// painéis e botões que essa conta pode usar (fiscalizador, comunidade,
// frigorífico, mercado). As mesmas regras são conferidas pelo contrato;
// esconder botões é só conveniência, não segurança.
// =====================================================================

// Fiscalizador principal: quem implantou o contrato (cadastra e suspende)
function ePrincipal() {
  return Boolean(estado.conta && estado.fiscalizador
    && estado.conta.toLowerCase() === estado.fiscalizador.toLowerCase());
}

// Igual a eFiscalizador() do contrato: o principal ou um adicional ativo
function eFiscalizador() {
  return ePrincipal() || (estado.papel === PAPEL_FISCALIZADOR && estado.ativo);
}

function vendedorAtivo(endereco) {
  const p = estado.participantes.get(endereco.toLowerCase());
  return !p || p.ativo;
}

function eMeu(endereco) {
  return Boolean(estado.conta && endereco.toLowerCase() === estado.conta.toLowerCase());
}

// Quem pode comprar em cada etapa (igual a _proximoPapel do contrato):
// na comunidade (0) compra o frigorífico (2); no frigorífico (1), o mercado (3).
function proximoPapel(etapa) {
  return etapa < 2 ? etapa + 2 : 0;
}

async function renderizarPaineis() {
  const conectado = Boolean(estado.conta) && contratoConfigurado();
  $("painelFiscal").hidden = !(conectado && eFiscalizador());
  $("painelComunidade").hidden = !(conectado && estado.papel === 1);
  $("painelSaldo").hidden = !(conectado && estado.papel > 0 && estado.papel !== PAPEL_FISCALIZADOR);

  // Cadastrar e suspender: só o fiscalizador principal
  document.querySelectorAll(".so-principal").forEach((f) => { f.hidden = !ePrincipal(); });
  $("dicaFiscal").textContent = ePrincipal()
    ? "Você é o fiscalizador principal: cadastra e suspende participantes, autoriza o manejo e apreende peixes."
    : "Você é fiscalizador adicional: autoriza o manejo e apreende peixes. Cadastro e suspensão são do fiscalizador principal.";

  // Participantes conhecidos (pelos eventos) como sugestão nos formulários do fiscalizador
  const opcoes = (filtro) => [...estado.participantes.entries()]
    .filter(([, p]) => filtro(p))
    .map(([conta, p]) => el("option", { value: conta }, `${p.nome} · ${PAPEIS[p.papel]}${p.ativo ? "" : " (suspenso)"}`));
  $("listaComunidades").replaceChildren(...opcoes((p) => p.papel === 1));
  $("listaParticipantes").replaceChildren(...opcoes(() => true));

  if (!conectado) return;
  try {
    if (estado.papel > 0) {
      const saldo = await estado.contratoLeitura.methods.saldos(estado.conta).call();
      $("saldoVendas").textContent = eth(saldo);
    }
    if (estado.papel === 1 && !estado.ativo) {
      $("infoCota").textContent = "Sua conta está suspensa pelo fiscalizador: não é possível registrar capturas.";
    } else if (estado.papel === 1) {
      const cota = await estado.contratoLeitura.methods.cotas(estado.conta).call();
      const limite = Number(cota.limite);
      const capturados = Number(cota.capturados);
      $("infoCota").textContent = limite === 0
        ? "Sua comunidade ainda não foi autorizada pelo fiscalizador."
        : `Cota: ${capturados} de ${limite} peixes capturados (${limite - capturados} restantes, `
          + `${cota.adultosContados} adultos contados). Tamanho mínimo: 1,50 m.`;
    }
  } catch (e) {
    console.error(e);
  }
}

function renderizarPeixes() {
  const alvo = $("listaPeixes");
  if (!contratoConfigurado()) {
    alvo.replaceChildren(el("p", { class: "vazio" }, "Configure o endereço do contrato em contrato.js."));
    return;
  }
  const filtro = $("filtroPeixes").value;
  let lista = [...estado.peixes].reverse(); // mais novos primeiro
  if (filtro === "meus") lista = lista.filter((p) => eMeu(p.dono));
  if (filtro === "comprar") {
    lista = lista.filter((p) => p.preco > 0n && estado.papel && proximoPapel(p.etapa) === estado.papel);
  }
  if (!lista.length) {
    alvo.replaceChildren(el("p", { class: "vazio" }, "Nenhum peixe para mostrar."));
    return;
  }
  alvo.replaceChildren(...lista.map(cartaoPeixe));
}

function detalhesPeixe(p) {
  const linhas = [
    ["Comprimento", `${metros(p.comprimentoCm)} m`],
    ["Peso", `${kg(p.pesoGramas)} kg`],
    ["Local", p.local],
    ["Comunidade", nomeDe(p.comunidade)],
    ["Dono atual", nomeDe(p.dono)],
    ["Capturado em", new Date(p.capturadoEm * 1000).toLocaleString("pt-BR")],
  ];
  if (p.armazenado) linhas.push(["Armazenamento", `${p.temperaturaC} °C`]);
  if (p.preco > 0n) linhas.push(["À venda por", `${eth(p.preco)} ETH`]);
  return el("dl", {}, ...linhas.flatMap(([k, v]) => [
    el("dt", {}, k),
    el("dd", k === "À venda por" ? { class: "preco" } : {}, v),
  ]));
}

function cartaoPeixe(p) {
  const acoes = acoesDoPeixe(p);
  return el("article", { class: `peixe etapa-${p.etapa}` },
    el("div", { class: "peixe-topo" },
      el("strong", {}, `#${p.id} · ${p.lacre}`),
      el("span", { class: "etapa" }, ETAPAS[p.etapa])),
    detalhesPeixe(p),
    acoes.length ? el("div", { class: "acoes" }, ...acoes) : null,
  );
}

// Botão pequeno de ação; o clique recebe o próprio botão (para desabilitar durante o envio)
function botao(texto, classe, aoClicar) {
  const b = el("button", { class: ["btn", classe, "btn-pequeno"].filter(Boolean).join(" ") }, texto);
  b.addEventListener("click", () => aoClicar(b));
  return b;
}

// Monta só os botões que a conta conectada pode usar neste peixe
function acoesDoPeixe(p) {
  if (!estado.conta || !estado.naSepolia) return [];
  const acoes = [];
  // Conta suspensa não negocia (o contrato também confere)
  const meu = eMeu(p.dono) && estado.ativo;

  if (meu && p.etapa === 1 && !p.armazenado) {
    const temp = el("input", { type: "number", step: "1", placeholder: "Temperatura °C (ex.: -18)" });
    acoes.push(el("div", { class: "acao" }, temp, botao("Registrar armazenamento", "", (b) => {
      const t = Number(temp.value);
      if (temp.value === "" || !Number.isInteger(t)) return toast("Informe a temperatura em °C (número inteiro).", true);
      enviar(`Armazenar peixe #${p.id} a ${t} °C`, metodos().registrarArmazenamento(p.id, t), 0n, b);
    })));
  }
  // Na comunidade pode vender direto; no frigorífico, só depois do armazenamento
  if (meu && p.preco === 0n && (p.etapa === 0 || (p.etapa === 1 && p.armazenado))) {
    const preco = el("input", { type: "text", inputmode: "decimal", placeholder: "Preço em ETH (ex.: 0.01)" });
    acoes.push(el("div", { class: "acao" }, preco, botao("Pôr à venda", "", (b) => {
      const texto = preco.value.trim().replace(",", ".");
      if (!(Number(texto) > 0)) return toast("Informe um preço em ETH maior que zero.", true);
      let wei;
      try {
        wei = Web3.utils.toWei(texto, "ether");
      } catch {
        return toast("Preço inválido.", true);
      }
      enviar(`Pôr peixe #${p.id} à venda por ${texto} ETH`, metodos().colocarAVenda(p.id, wei), 0n, b);
    })));
  }
  if (meu && p.preco > 0n) {
    acoes.push(botao("Cancelar venda", "btn-claro", (b) =>
      enviar(`Cancelar venda do peixe #${p.id}`, metodos().cancelarVenda(p.id), 0n, b)));
  }
  if (!eMeu(p.dono) && p.preco > 0n && estado.ativo && vendedorAtivo(p.dono)
    && estado.papel === proximoPapel(p.etapa)) {
    // Envia ETH junto com a transação (value)
    acoes.push(botao(`Comprar por ${eth(p.preco)} ETH`, "btn-compra", (b) =>
      enviar(`Comprar peixe #${p.id} por ${eth(p.preco)} ETH`, metodos().comprar(p.id), p.preco, b)));
  }
  if (meu && p.etapa === 2) {
    acoes.push(botao("Registrar venda ao consumidor", "", (b) =>
      enviar(`Venda ao consumidor do peixe #${p.id}`, metodos().registrarVendaAoConsumidor(p.id), 0n, b)));
  }
  if (eFiscalizador() && p.etapa < 3) {
    const motivo = el("input", { type: "text", maxlength: "100", placeholder: "Motivo da apreensão" });
    acoes.push(el("div", { class: "acao" }, motivo, botao("Apreender", "btn-perigo", (b) => {
      if (!motivo.value.trim()) return toast("Informe o motivo da apreensão.", true);
      enviar(`Apreender peixe #${p.id}`, metodos().apreender(p.id, motivo.value.trim()), 0n, b);
    })));
  }
  return acoes;
}

function renderizarEventos() {
  const alvo = $("listaEventos");
  if (!estado.eventos.length) {
    alvo.replaceChildren(el("li", { class: "vazio" }, "Nenhum evento ainda."));
    return;
  }
  const recentes = [...estado.eventos].reverse().slice(0, MAX_EVENTOS_NA_TELA);
  alvo.replaceChildren(...recentes.map((e) => el("li", {},
    el("div", { class: "evento-nome" }, e.event),
    el("div", {}, descreverEvento(e)),
    el("div", { class: "evento-meta" }, `bloco ${e.blockNumber} · `, linkTx(e.transactionHash, curto(e.transactionHash))),
  )));
}

function descreverEvento(e) {
  const v = e.returnValues;
  switch (e.event) {
    case "ParticipanteCadastrado":
      return `${PAPEIS[Number(v.papel)]} "${v.nome}" cadastrado (${curto(v.conta)}).`;
    case "ParticipanteAtivoAlterado":
      return `${nomeDe(v.conta)} ${v.ativo ? "reativado" : "suspenso"} pelo fiscalizador principal.`;
    case "ManejoAutorizado":
      return `Manejo autorizado para ${nomeDe(v.comunidade)}: ${v.adultosContados} adultos, cota de ${v.limite} peixes.`;
    case "PeixeRegistrado":
      return `Peixe #${v.id} (lacre ${v.lacre}) pescado por ${nomeDe(v.comunidade)}: `
        + `${metros(Number(v.comprimentoCm))} m, ${kg(Number(v.pesoGramas))} kg.`;
    case "PeixeAVenda":
      return `Peixe #${v.id} posto à venda por ${nomeDe(v.vendedor)} por ${eth(v.preco)} ETH.`;
    case "VendaCancelada":
      return `${nomeDe(v.vendedor)} tirou o peixe #${v.id} da venda.`;
    case "PeixeVendido":
      return `Peixe #${v.id} vendido de ${nomeDe(v.vendedor)} para ${nomeDe(v.comprador)} `
        + `por ${eth(v.valor)} ETH (${ETAPAS[Number(v.novaEtapa)].toLowerCase()}).`;
    case "ArmazenamentoRegistrado":
      return `Peixe #${v.id} armazenado por ${nomeDe(v.frigorifico)} a ${v.temperaturaC} °C.`;
    case "VendidoAoConsumidor":
      return `Peixe #${v.id} vendido ao consumidor por ${nomeDe(v.mercado)}.`;
    case "PeixeApreendido":
      return `Peixe #${v.id} apreendido pelo fiscalizador. Motivo: ${v.motivo}.`;
    case "Saque":
      return `${nomeDe(v.conta)} sacou ${eth(v.valor)} ETH.`;
    default:
      return e.event || "Evento";
  }
}

// ---------- lista de transações ----------

function adicionarTx(descricao) {
  const lista = $("listaTx");
  lista.querySelector(".vazio")?.remove();
  const status = el("span", { class: "status assinatura" }, "aguardando assinatura");
  const detalhe = el("div", { class: "hash" });
  const item = el("li", {}, el("div", { class: "tx-topo" }, el("span", {}, descricao), status), detalhe);
  item._status = status;
  item._detalhe = detalhe;
  lista.prepend(item);
  return item;
}

function atualizarTx(item, situacao, hash, mensagem) {
  item._status.className = `status ${situacao}`;
  item._status.textContent = situacao;
  const partes = [];
  if (hash) partes.push(linkTx(hash, hash));
  if (mensagem) partes.push(el("div", {}, mensagem));
  if (partes.length) item._detalhe.replaceChildren(...partes);
}

// =====================================================================
// 8) TRATAMENTO DE ERROS
// ---------------------------------------------------------------------
// mensagemDeErro() transforma qualquer falha numa frase clara:
//   - código 4001: o usuário rejeitou na MetaMask;
//   - revert com erro personalizado: os 4 primeiros bytes dos dados do
//     revert são o seletor (keccak256 da assinatura, ex.:
//     "CotaEsgotada(uint256,uint256)"). montarSeletoresDeErro() gera esse
//     mapa a partir da ABI, e decodificarErro() decodifica os parâmetros
//     para montar a mensagem com os valores (ex.: "3 de 3 peixes");
//   - revert de require: seletor 0x08c379a0 = Error(string);
//   - "insufficient funds": falta ETH para o valor e o gas;
//   - código -32002: já existe um pedido aberto na MetaMask.
// =====================================================================

const MENSAGENS = {
  ApenasFiscalizador: () => "Só um fiscalizador ativo pode fazer isso.",
  ApenasFiscalizadorPrincipal: () => "Só o fiscalizador principal (quem implantou o contrato) pode fazer isso.",
  ParticipanteNaoEncontrado: (a) => `A conta ${curto(a.conta)} não é um participante cadastrado.`,
  ParticipanteInativo: (a) => `A conta ${nomeDe(a.conta)} está suspensa pelo fiscalizador.`,
  PapelInvalido: (a) => `Ação permitida só para ${PAPEIS[Number(a.esperado)]}. Sua conta: ${PAPEIS[Number(a.atual)]}.`,
  ParticipanteJaCadastrado: (a) => `A conta ${curto(a.conta)} já está cadastrada, e o papel não pode ser trocado.`,
  ComunidadeNaoAutorizada: () => "Esta comunidade ainda não foi autorizada pelo fiscalizador.",
  CotaEsgotada: (a) => `Cota esgotada: a comunidade já capturou ${a.capturados} de ${a.limite} peixes.`,
  CotaMenorQueCapturados: (a) => `A nova cota (${a.novoLimite}) ficaria menor que os ${a.capturados} peixes já capturados.`,
  LacreInvalido: (a) => `Lacre "${a.lacre}" inválido: use de 3 a 20 caracteres entre A-Z, 0-9 e hífen.`,
  LacreJaUsado: (a) => `O lacre ${a.lacre} já foi usado em outro peixe.`,
  LacreNaoEncontrado: (a) => `Nenhum peixe registrado com o lacre ${a.lacre}.`,
  TamanhoForaDaFaixa: (a) => `Peixe com ${metros(Number(a.informadoCm))} m está fora da faixa permitida `
    + `(${metros(Number(a.minimoCm))} m a ${metros(Number(a.maximoCm))} m).`,
  PesoInvalido: (a) => `Peso inválido: deve ser maior que 0 e no máximo ${kg(Number(a.maximoG))} kg.`,
  PeixeInexistente: (a) => `Não existe peixe com o id ${a.id}.`,
  NaoEDonoDoPeixe: (a) => `Só o dono atual do peixe #${a.id} pode fazer isso.`,
  EtapaInvalida: (a) => `O peixe #${a.id} está "${ETAPAS[Number(a.atual)]}", mas a ação exige "${ETAPAS[Number(a.esperada)]}".`,
  PeixeNaoNegociavel: (a) => `O peixe #${a.id} está "${ETAPAS[Number(a.atual)]}" e não pode mais ser negociado.`,
  ArmazenamentoNaoRegistrado: (a) => `Registre a temperatura de armazenamento do peixe #${a.id} antes de vendê-lo.`,
  TemperaturaInadequada: (a) => `${a.informada} °C está fora da cadeia do frio (de ${a.minima} a ${a.maxima} °C).`,
  PeixeNaoEstaAVenda: (a) => `O peixe #${a.id} não está à venda.`,
  ValorIncorreto: (a) => `Valor incorreto: o preço é ${eth(a.esperado)} ETH e foram enviados ${eth(a.enviado)} ETH.`,
  SaldoInsuficiente: (a) => `Saldo insuficiente: disponível ${eth(a.disponivel)} ETH, pedido ${eth(a.solicitado)} ETH.`,
  FalhaNoSaque: () => "A transferência do saque falhou.",
};

function montarSeletoresDeErro(abi) {
  const mapa = new Map();
  for (const item of abi) {
    if (item.type !== "error") continue;
    const assinatura = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    mapa.set(abiUtil.encodeFunctionSignature(assinatura).toLowerCase(), item);
  }
  return mapa;
}

// O erro chega aninhado de formas diferentes (Web3.js, MetaMask, RPC público).
// Percorre tudo uma vez e junta o que interessa: os códigos, as mensagens e os
// dados do revert (o primeiro "0x" + seletor encontrado).
function examinarErro(e) {
  const r = { codigos: [], textos: [], dadosRevert: null };
  const visitar = (obj, nivel, dentroDeData) => {
    if (obj === null || obj === undefined || nivel > 6) return;
    if (typeof obj === "string") {
      if (!r.dadosRevert && /^0x[0-9a-fA-F]{8}/.test(obj)) r.dadosRevert = obj;
      if (!dentroDeData) r.textos.push(obj);
      return;
    }
    if (typeof obj !== "object") return;
    r.codigos.push(obj.code);
    if (!dentroDeData && obj.message) r.textos.push(obj.message);
    visitar(obj.data, nivel + 1, true);
    for (const k of ["innerError", "cause", "error", "originalError"]) visitar(obj[k], nivel + 1, dentroDeData);
  };
  visitar(e, 0, false);
  return { codigos: r.codigos, dadosRevert: r.dadosRevert, texto: r.textos.join(" | ") };
}

function decodificarErro(dados) {
  const seletor = dados.slice(0, 10).toLowerCase();
  const corpo = `0x${dados.slice(10)}`;
  try {
    if (seletor === "0x08c379a0") { // Error(string) - vem dos require
      const r = abiUtil.decodeParameters(["string"], corpo);
      return { nome: "Error", args: { mensagem: r[0] } };
    }
    const def = seletoresDeErro.get(seletor);
    if (!def) return null;
    return { nome: def.name, args: abiUtil.decodeParameters(def.inputs, corpo) };
  } catch {
    return null;
  }
}

function hashDoErro(e) {
  return e?.receipt?.transactionHash || e?.transactionHash || null;
}

function mensagemDeErro(e) {
  const { codigos, texto, dadosRevert } = examinarErro(e);
  if (codigos.includes(4001) || /user (denied|rejected)/i.test(texto)) {
    return "Você rejeitou a transação na MetaMask.";
  }
  if (dadosRevert) {
    const erro = decodificarErro(dadosRevert);
    if (erro) {
      if (erro.nome === "Error") return `O contrato recusou: ${erro.args.mensagem}.`;
      return MENSAGENS[erro.nome] ? MENSAGENS[erro.nome](erro.args) : `O contrato recusou (${erro.nome}).`;
    }
  }
  if (/insufficient funds/i.test(texto)) return "Saldo de ETH insuficiente para pagar o valor e o gas.";
  if (codigos.includes(-32002)) return "Já existe um pedido aberto na MetaMask. Abra a extensão para responder.";
  if (/revert/i.test(texto)) return "O contrato recusou a transação.";
  return texto || "Erro desconhecido.";
}

// =====================================================================
// 9) UTILITÁRIOS
// ---------------------------------------------------------------------
// Dados on-chain também são entrada não confiável: nomes, lacres, locais
// e motivos foram digitados por alguém. Por isso a tela é montada com
// el(), que usa textContent (nunca innerHTML) e evita XSS.
// =====================================================================

// Cria elementos com textContent (nunca innerHTML), para que nomes e lacres
// digitados por usuários não virem HTML na página.
function el(tag, atributos = {}, ...filhos) {
  const elemento = document.createElement(tag);
  for (const [k, v] of Object.entries(atributos)) elemento.setAttribute(k, v);
  for (const filho of filhos) {
    if (filho === null || filho === undefined) continue;
    elemento.append(filho instanceof Node ? filho : String(filho));
  }
  return elemento;
}

function linkTx(hash, texto) {
  return el("a", { href: `${SEPOLIA.explorer}/tx/${hash}`, target: "_blank", rel: "noopener" }, texto);
}

function curto(endereco) {
  return endereco ? `${endereco.slice(0, 6)}…${endereco.slice(-4)}` : "–";
}

function nomeDe(endereco) {
  if (!endereco) return "–";
  if (estado.fiscalizador && endereco.toLowerCase() === estado.fiscalizador.toLowerCase()) return "Fiscalizador principal";
  const p = estado.participantes.get(endereco.toLowerCase());
  const nome = p ? p.nome : curto(endereco);
  return eMeu(endereco) ? `${nome} (você)` : nome;
}

function eth(wei) {
  const valor = Number(Web3.utils.fromWei(BigInt(wei).toString(), "ether"));
  return valor.toLocaleString("pt-BR", { maximumFractionDigits: 6 });
}

function metros(cm) {
  return (cm / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
}

function kg(gramas) {
  return (gramas / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

let temporizadorToast = null;
function toast(mensagem, erro = false) {
  const t = $("toast");
  t.textContent = mensagem;
  t.className = `toast${erro ? " erro" : ""}`;
  t.hidden = false;
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => { t.hidden = true; }, erro ? TEMPO_AVISO_ERRO_MS : TEMPO_AVISO_MS);
}

function aviso(mensagem) {
  const a = $("avisoContrato");
  a.textContent = mensagem;
  a.hidden = false;
}
