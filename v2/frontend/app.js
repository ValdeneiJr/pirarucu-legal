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
  conta: null, // conta ativa: a que assina as transações (from)
  contas: [], // todas as contas que a MetaMask autorizou neste site
  saldosContas: new Map(), // endereço (minúsculo) -> saldo em wei (BigInt)
  naSepolia: false,
  fiscalizador: null,
  papel: 0,
  nome: "",
  peixes: [],
  filtro: "tudo", // filtro da lista de peixes (frigorífico e mercado): tudo, meus ou comprar
  eventos: [],
  chavesEventos: new Set(), // "hash:índice" de cada log já guardado
  ultimoBlocoEventos: null,
  participantes: new Map(), // endereço (minúsculo) -> { nome, papel }
  cotas: new Map(), // endereço da comunidade (minúsculo) -> { adultosContados, limite, capturados }
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
    definirContas(contas, lerContaSalva());
    await verificarRede();
  } else {
    $("avisoMetaMask").hidden = false;
  }

  configurarProvedores();
  await atualizarTudo();
}

function contratoConfigurado() {
  return typeof CONTRATO !== "undefined" && Web3.utils.isAddress(CONTRATO.endereco);
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
  $("formConsulta").addEventListener("submit", consultarLacre);
  ligarMenuDeContas();
  ligarAbas();
  ligarFormularios();

  // Filtro dos peixes (botões segmentados)
  $("filtroPeixes").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filtro]");
    if (!b) return;
    estado.filtro = b.dataset.filtro;
    renderizarPeixes();
  });
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
//
// Troca rápida de conta (trocarConta):
//   eth_accounts devolve TODAS as contas que o usuário autorizou para o
//   site, não só a selecionada na extensão. O app guarda essa lista e deixa
//   escolher a conta ativa com um clique no menu da conta (canto superior direito).
//   A conta escolhida vai no campo "from" de cada transação, e a MetaMask
//   assina com ela, sem precisar trocar de conta na extensão. Para incluir
//   mais contas, wallet_requestPermissions reabre a tela de seleção.
// =====================================================================

async function conectar() {
  if (!window.ethereum) {
    toast("Instale a MetaMask para conectar a carteira.", true);
    return;
  }
  try {
    const contas = await window.ethereum.request({ method: "eth_requestAccounts" });
    definirContas(contas);
    await aoTrocarRede();
    if (!estado.naSepolia) toast("Conectado. Agora troque a rede para Sepolia.", true);
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

// A MetaMask avisa quando a conta selecionada ou a lista autorizada muda.
// A primeira da lista é a selecionada na extensão: ela passa a ser a ativa.
async function aoTrocarConta(contas) {
  const anterior = estado.conta;
  definirContas(contas);
  salvarConta(estado.conta);
  if (estado.conta !== anterior) {
    toast(estado.conta ? `Agindo como ${rotuloConta(estado.conta).nome}.` : "Carteira desconectada.");
  }
  await atualizarTudo();
}

async function aoTrocarRede() {
  await verificarRede();
  configurarProvedores();
  await atualizarTudo();
}

// Guarda a lista de contas autorizadas e escolhe a ativa: a preferida (se
// ainda estiver autorizada) ou a selecionada na MetaMask (primeira da lista).
function definirContas(contas, preferida = null) {
  estado.contas = contas || [];
  const achada = preferida && estado.contas.find((c) => c.toLowerCase() === preferida.toLowerCase());
  estado.conta = achada || estado.contas[0] || null;
}

// Troca rápida: muda a conta ativa do app sem abrir a MetaMask
async function trocarConta(conta) {
  if (!conta || conta === estado.conta) return fecharMenuContas();
  estado.conta = conta;
  salvarConta(conta);
  fecharMenuContas();
  // Mostra na hora o que já se sabe (nome e papel vêm dos eventos) e depois confirma no contrato
  const conhecido = estado.participantes.get(conta.toLowerCase());
  estado.papel = conhecido ? conhecido.papel : 0;
  estado.nome = conhecido ? conhecido.nome : "";
  renderizarTela();
  toast(`Agindo como ${rotuloConta(conta).nome}.`);
  try {
    await carregarSaldos();
    if (contratoConfigurado()) await atualizarPapel();
  } catch (e) {
    console.error(e);
  }
  if (estado.conta !== conta) return; // trocou de novo enquanto carregava
  renderizarTela();
}

// Abre a tela da MetaMask para escolher quais contas o site pode usar
// Algumas versões da MetaMask não abrem a tela quando o site já está
// conectado; nesse caso, o aviso explica como incluir contas pela extensão.
async function conectarMaisContas() {
  fecharMenuContas();
  const antes = estado.contas.length;
  try {
    await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    const contas = await window.ethereum.request({ method: "eth_accounts" });
    definirContas(contas, estado.conta);
    await atualizarTudo();
    if (estado.contas.length <= antes) toast(DICA_MAIS_CONTAS, true);
  } catch (e) {
    toast(e && e.code === 4001 ? mensagemDeErro(e) : `${mensagemDeErro(e)} ${DICA_MAIS_CONTAS}`, true);
  }
}

// Revoga a permissão do site (MetaMask recente). Sem suporte, só limpa a tela.
async function desconectar() {
  fecharMenuContas();
  try {
    await window.ethereum.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch (e) {
    console.warn("wallet_revokePermissions indisponível:", e);
  }
  definirContas([]);
  salvarConta(null);
  toast("Carteira desconectada.");
  await atualizarTudo();
}

function ligarMenuDeContas() {
  $("btnConta").addEventListener("click", (e) => {
    e.stopPropagation();
    if ($("menuContas").hidden) abrirMenuContas();
    else fecharMenuContas();
  });
  $("menuContas").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", fecharMenuContas);
  $("btnMaisContas").addEventListener("click", conectarMaisContas);
  $("btnDesconectar").addEventListener("click", desconectar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") fecharMenuContas();
  });
}

function abrirMenuContas() {
  $("menuContas").hidden = false;
  $("btnConta").setAttribute("aria-expanded", "true");
}

function fecharMenuContas() {
  $("menuContas").hidden = true;
  $("btnConta").setAttribute("aria-expanded", "false");
}

// A última conta escolhida fica no navegador, para continuar nela ao recarregar
function salvarConta(conta) {
  try {
    if (conta) localStorage.setItem("pirarucu:conta", conta);
    else localStorage.removeItem("pirarucu:conta");
  } catch { /* armazenamento bloqueado: segue sem lembrar */ }
}

function lerContaSalva() {
  try {
    return localStorage.getItem("pirarucu:conta");
  } catch {
    return null;
  }
}

// Abas do painel do fiscalizador
function ligarAbas() {
  document.querySelectorAll(".aba").forEach((aba) => {
    aba.addEventListener("click", () => mostrarAba(aba.dataset.aba));
  });
  mostrarAba(document.querySelector(".aba").dataset.aba);
}

function mostrarAba(id) {
  document.querySelectorAll(".aba").forEach((aba) => {
    const ativa = aba.dataset.aba === id;
    aba.setAttribute("aria-selected", String(ativa));
    $(aba.dataset.aba).classList.toggle("aba-oculta", !ativa);
  });
}

// =====================================================================
// 4) LEITURA COM .call() - NÃO GERA TRANSAÇÃO NEM CUSTA GAS
// ---------------------------------------------------------------------
// .call() vira um eth_call: o nó executa a função sobre o estado atual e
// devolve o resultado, sem assinatura e sem alterar a blockchain. Serve
// para funções view/pure e para os getters automáticos das variáveis
// public (fiscalizador(), participantes(conta), cotas(conta), totalNegociadoWei()).
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
    await carregarSaldos();
    if (contratoConfigurado()) {
      await Promise.all([carregarResumo(), carregarPeixes(), carregarEventos()]);
      // As comunidades vêm dos eventos, por isso as cotas são lidas depois
      await Promise.all([atualizarPapel(), carregarCotas()]);
    }
  } catch (e) {
    console.error(e);
    toast(`Não foi possível ler o contrato: ${mensagemDeErro(e)}`, true);
  }
  renderizarTela();
}

// Partes da tela que dependem da conta ativa
function renderizarTela() {
  renderizarContas();
  renderizarPaineis();
  renderizarCotas();
  renderizarPeixes();
  renderizarEventos();
}

// Saldo em ETH de todas as contas conectadas (aparece no menu de troca)
async function carregarSaldos() {
  const saldos = await Promise.all(
    estado.contas.map((c) => estado.web3Carteira.eth.getBalance(c).catch(() => null)),
  );
  estado.contas.forEach((c, i) => {
    if (saldos[i] !== null) estado.saldosContas.set(c.toLowerCase(), BigInt(saldos[i]));
  });
}

// Papel da conta ativa, lido do contrato (getter público "participantes")
async function atualizarPapel() {
  const conta = estado.conta;
  if (!conta) {
    estado.papel = 0;
    return;
  }
  let papel = 0;
  let nome = "";
  if (!ePrincipal()) {
    const p = await estado.contratoLeitura.methods.participantes(conta).call();
    papel = Number(p.papel);
    nome = p.nome;
  }
  if (estado.conta !== conta) return; // a conta mudou durante a leitura
  estado.papel = papel;
  estado.nome = nome;
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

// Cota de cada comunidade cadastrada (getter público "cotas"), lidas em paralelo
async function carregarCotas() {
  const comunidades = [...estado.participantes.entries()].filter(([, p]) => p.papel === 1).map(([conta]) => conta);
  const cotas = await Promise.all(comunidades.map((c) => estado.contratoLeitura.methods.cotas(c).call()));
  estado.cotas = new Map(comunidades.map((c, i) => [c, {
    adultosContados: Number(cotas[i].adultosContados),
    limite: Number(cotas[i].limite),
    capturados: Number(cotas[i].capturados),
  }]));
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
    preco: BigInt(p.preco),
    valorPago: BigInt(p.valorPago),
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
//   - "allEvents" traz todos os 6 eventos do contrato de uma vez; a ABI
//     decodifica os argumentos em ev.returnValues.
//   - Começa no bloco do deploy (CONTRATO.blocoDeploy), e não no bloco 0.
//   - RPCs públicos limitam o intervalo de eth_getLogs, então a busca é
//     feita em lotes de PASSO_EVENTOS blocos.
//   - Guarda o último bloco lido: nas próximas atualizações, busca só os
//     blocos novos. Duas atualizações ao mesmo tempo (ex.: fim de uma
//     transação + troca de conta) podem ler o mesmo trecho; a chave
//     "hash:índice" impede que um evento apareça duas vezes.
//   - O evento ParticipanteCadastrado alimenta o mapa endereço -> { nome,
//     papel }, usado para mostrar "Comunidade X" em vez de 0x1234…abcd.
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
    const chave = `${ev.transactionHash}:${ev.logIndex}`;
    if (estado.chavesEventos.has(chave)) continue;
    estado.chavesEventos.add(chave);
    estado.eventos.push(ev);
    const v = ev.returnValues;
    if (ev.event === "ParticipanteCadastrado") {
      estado.participantes.set(v.conta.toLowerCase(), { nome: v.nome, papel: Number(v.papel) });
    }
  }
  estado.ultimoBlocoEventos = Math.max(estado.ultimoBlocoEventos ?? 0, atual);
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

  ligarFormulario("formCaptura", (e) => {
    const lacre = e.lacre.value.trim().toUpperCase();
    const cm = Math.round(Number(e.comprimento.value) * 100);
    const gramas = Math.round(Number(e.peso.value) * 1000);
    return [`Registrar peixe ${lacre}`, metodos().registrarCaptura(lacre, cm, gramas, e.local.value.trim())];
  });
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

// Fiscalizador: quem implantou o contrato (dono). Igual ao modificador
// apenasFiscalizador do contrato.
function ePrincipal() {
  return mesmoEndereco(estado.conta, estado.fiscalizador);
}

// Cada tipo de usuário vê só o que é dele e o que é público para ele.
// A blockchain é pública (tudo pode ser lido no Etherscan); a separação é da tela.
function visao() {
  if (!estado.conta || !contratoConfigurado()) return "visitante";
  if (ePrincipal()) return "fiscal";
  return ["visitante", "comunidade", "frigorifico", "mercado"][estado.papel] || "visitante";
}

// O peixe é "meu" se eu sou o dono atual, se minha comunidade o pescou ou se
// eu já o vendi (evento PeixeVendido com vendedor = minha conta)
function participeiDoPeixe(p) {
  return eMeu(p.dono) || eMeu(p.comunidade) || estado.eventos.some((e) => e.event === "PeixeVendido"
    && Number(e.returnValues.id) === p.id && eMeu(e.returnValues.vendedor));
}

// O evento envolve a conta ativa em algum dos seus endereços?
function eventoEnvolveMim(e) {
  const v = e.returnValues || {};
  return ["conta", "comunidade", "vendedor", "comprador", "mercado"].some((k) => v[k] && eMeu(v[k]));
}

function eMeu(endereco) {
  return mesmoEndereco(endereco, estado.conta);
}

// Endereços podem vir com letras maiúsculas (checksum) ou minúsculas
function mesmoEndereco(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

// A conta ativa pode comprar este peixe? (o contrato confere o mesmo em comprar)
function podeComprar(p) {
  return !eMeu(p.dono) && p.preco > 0n && estado.papel > 0 && estado.papel === proximoPapel(p.etapa);
}

// Quem pode comprar em cada etapa (igual a _proximoPapel do contrato):
// na comunidade (0) compra o frigorífico (2); no frigorífico (1), o mercado (3).
function proximoPapel(etapa) {
  return etapa < 2 ? etapa + 2 : 0;
}

// Nome e papel de uma conta, para o menu de troca e a lista de transações.
// A conta ativa usa o que foi lido do contrato; as outras, o mapa montado
// pelos eventos ParticipanteCadastrado.
function rotuloConta(endereco) {
  if (mesmoEndereco(endereco, estado.fiscalizador)) return { nome: "Fiscalizador", papel: "Dono do contrato" };
  const ativa = eMeu(endereco) && estado.papel > 0;
  const p = ativa ? { nome: estado.nome, papel: estado.papel } : estado.participantes.get(endereco.toLowerCase());
  if (!p) return { nome: curto(endereco), papel: "Sem papel" };
  return { nome: p.nome, papel: PAPEIS[p.papel] };
}

// Cor fixa por endereço, para reconhecer cada conta de relance
function avatar(endereco, classe = "") {
  const tom = parseInt(endereco.slice(2, 8), 16) % 360;
  const nome = rotuloConta(endereco).nome.replace(/^0x/, "");
  return el("span", { class: `avatar ${classe}`.trim(), style: `--cor: hsl(${tom} 45% 38%)`, "aria-hidden": "true" },
    nome.charAt(0));
}

// Cabeçalho: botão da conta ativa e o menu suspenso com todas as contas
function renderizarContas() {
  const conectado = Boolean(estado.conta);
  $("infoConta").hidden = !conectado;
  $("btnConectar").hidden = conectado;
  if (!conectado) {
    fecharMenuContas();
    return;
  }
  const r = rotuloConta(estado.conta);
  const saldo = estado.saldosContas.get(estado.conta.toLowerCase());
  $("contaAvatar").replaceWith(Object.assign(avatar(estado.conta), { id: "contaAvatar" }));
  $("contaNome").textContent = r.nome;
  $("papel").textContent = `${r.papel} · ${curto(estado.conta)}`;
  $("saldoEth").textContent = saldo === undefined ? "" : `${eth(saldo)} ETH`;
  $("endereco").href = `${SEPOLIA.explorer}/address/${estado.conta}`;

  $("listaContas").replaceChildren(...estado.contas.map((c) => {
    const rc = rotuloConta(c);
    const s = estado.saldosContas.get(c.toLowerCase());
    const item = el("button", { class: `item-conta${eMeu(c) ? " ativa" : ""}`, type: "button" },
      avatar(c),
      el("span", {},
        el("span", { class: "nome" }, rc.nome),
        el("span", { class: "sub" }, `${rc.papel} · `, el("span", { class: "mono" }, curto(c)))),
      el("span", { class: "lado" }, s === undefined ? "" : `${eth(s)} ETH`));
    item.addEventListener("click", () => trocarConta(c));
    return el("li", {}, item);
  }));
}

async function renderizarPaineis() {
  const conectado = Boolean(estado.conta) && contratoConfigurado();
  // Painel administrativo: só o dono do contrato (o fiscalizador)
  $("painelFiscal").hidden = !(conectado && ePrincipal());
  $("painelComunidade").hidden = !(conectado && estado.papel === 1);
  $("totalParticipantes").textContent = contratoConfigurado() ? String(estado.participantes.size) : "–";

  // Contas conectadas ainda sem papel, como sugestão no formulário de cadastro
  $("listaSemPapel").replaceChildren(...estado.contas
    .filter((c) => !mesmoEndereco(c, estado.fiscalizador) && !estado.participantes.has(c.toLowerCase()))
    .map((c) => el("option", { value: c }, `Conta conectada ${curto(c)}`)));

  // Comunidades conhecidas (pelos eventos) como sugestão no formulário de manejo
  $("listaComunidades").replaceChildren(...[...estado.participantes.entries()]
    .filter(([, p]) => p.papel === 1)
    .map(([conta, p]) => el("option", { value: conta }, `${p.nome} · ${PAPEIS[p.papel]}`)));

  if (!conectado || estado.papel !== 1) return;
  const conta = estado.conta;
  try {
    const cota = await estado.contratoLeitura.methods.cotas(conta).call();
    if (estado.conta !== conta) return; // trocou de conta durante a leitura
    const limite = Number(cota.limite);
    const capturados = Number(cota.capturados);
    const barra = $("barraCota");
    barra.style.width = limite ? `${Math.min(100, (capturados / limite) * 100)}%` : "0";
    barra.classList.toggle("cheia", limite > 0 && capturados >= limite);
    $("infoCota").textContent = limite === 0
      ? "Sua comunidade ainda não foi autorizada pelo fiscalizador."
      : `Cota: ${capturados} de ${limite} peixes capturados (${limite - capturados} restantes, `
        + `${cota.adultosContados} adultos contados).`;
  } catch (e) {
    console.error(e);
  }
}

// Cartão por comunidade: capturados / limite, com barra de progresso
function renderizarCotas() {
  $("cardCotas").hidden = visao() !== "fiscal";
  const alvo = $("listaCotas");
  if (!contratoConfigurado()) {
    alvo.replaceChildren(el("p", { class: "vazio" }, "Configure o endereço do contrato em contrato.js."));
    return;
  }
  if (!estado.cotas.size) {
    alvo.replaceChildren(el("p", { class: "vazio" }, "Nenhuma comunidade cadastrada ainda."));
    return;
  }
  alvo.replaceChildren(...[...estado.cotas.entries()].map(([conta, c]) => {
    const autorizada = c.limite > 0;
    const esgotada = autorizada && c.capturados >= c.limite;
    const barra = el("span", { style: `width: ${autorizada ? Math.min(100, (c.capturados / c.limite) * 100) : 0}%` });
    if (esgotada) barra.classList.add("cheia");
    return el("article", { class: "cota-item" },
      el("div", { class: "cota-topo" },
        el("strong", {}, nomeDe(conta)),
        el("span", { class: `etiqueta${esgotada ? " esgotada" : autorizada ? "" : " pendente"}` },
          esgotada ? "Cota esgotada" : autorizada ? `${c.limite - c.capturados} restante(s)` : "Aguardando autorização")),
      el("div", { class: "cota-numeros" },
        el("strong", {}, String(c.capturados)), ` de ${c.limite} peixes capturados`),
      el("div", { class: "cota-barra" }, barra),
      el("small", {}, autorizada ? `${c.adultosContados} adultos contados · cota de ${PERCENTUAL_COTA}%` : "O fiscalizador ainda não autorizou o manejo."));
  }));
}

function renderizarPeixes() {
  const alvo = $("listaPeixes");
  if (!contratoConfigurado()) {
    alvo.replaceChildren(el("p", { class: "vazio" }, "Configure o endereço do contrato em contrato.js."));
    return;
  }
  const v = visao();
  $("cardPeixes").hidden = v === "visitante";
  // Só frigorífico e mercado compram: só eles alternam entre "meus" e "à venda para mim"
  const compra = v === "frigorifico" || v === "mercado";
  $("filtroPeixes").hidden = !compra;
  const filtro = compra ? estado.filtro : "meus";
  $("filtroPeixes").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.filtro === filtro)));
  const vendedores = v === "frigorifico" ? "as comunidades" : "os frigoríficos";
  const textos = {
    fiscal: ["Todos os peixes", "Como fiscalizador, você acompanha todos os peixes registrados."],
    tudo: ["Peixes", `Os seus peixes e os que ${vendedores} puseram à venda para você.`],
    meus: ["Meus peixes", "Peixes que são seus ou que já passaram por você."],
    comprar: ["À venda para mim", `Peixes que ${vendedores} puseram à venda para você.`],
  }[v === "fiscal" ? "fiscal" : filtro];
  $("tituloPeixes").textContent = textos[0];
  $("dicaPeixes").textContent = textos[1];

  const filtros = { tudo: (p) => participeiDoPeixe(p) || podeComprar(p), meus: participeiDoPeixe, comprar: podeComprar };
  let lista = [...estado.peixes].reverse(); // mais novos primeiro
  if (v !== "fiscal") lista = lista.filter(filtros[filtro]);
  if (!lista.length) {
    alvo.replaceChildren(el("p", { class: "vazio" }, filtro === "comprar" && compra
      ? "Nenhum peixe à venda para você agora."
      : "Nenhum peixe para mostrar."));
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
  if (p.valorPago > 0n) linhas.push(["Dono pagou", `${eth(p.valorPago)} ETH`]);
  if (p.preco > 0n) linhas.push(["À venda por", `${eth(p.preco)} ETH`]);
  return el("dl", {}, ...linhas.map(([k, v]) => el("div", {},
    el("dt", {}, k),
    el("dd", k === "À venda por" ? { class: "preco" } : {}, v),
  )));
}

// Trilha comunidade -> frigorífico -> mercado -> consumidor (o enum Etapa do
// contrato), com a etapa atual destacada.
function trilhaDoPeixe(p) {
  const passos = ["Comunidade", "Frigorífico", "Mercado", "Consumidor"];
  return el("ol", { class: "trilha", "aria-label": `Etapa: ${ETAPAS[p.etapa]}` },
    ...passos.map((nome, i) => {
      let classe = "";
      if (i < p.etapa) classe = "feito";
      if (i === p.etapa) classe = p.etapa === 3 ? "feito atual" : "atual";
      return el("li", classe ? { class: classe } : {}, nome);
    }));
}

function cartaoPeixe(p) {
  const acoes = acoesDoPeixe(p);
  const etiquetas = [el("span", { class: "etiqueta" }, ETAPAS[p.etapa])];
  if (p.preco > 0n) etiquetas.unshift(el("span", { class: "etiqueta venda" }, "À venda"));
  return el("article", { class: "peixe" },
    el("div", { class: "peixe-topo" },
      el("div", {}, el("span", { class: "lacre" }, p.lacre), el("span", { class: "id" }, `peixe #${p.id}`)),
      el("div", { class: "etiquetas" }, ...etiquetas)),
    trilhaDoPeixe(p),
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
  const meu = eMeu(p.dono);

  // Comunidade e frigorífico vendem para o próximo elo; chamar de novo troca o preço
  if (meu && proximoPapel(p.etapa) !== 0) {
    const preco = el("input", { type: "text", inputmode: "decimal", placeholder: "Preço em ETH (ex.: 0.01)" });
    acoes.push(el("div", { class: "acao" }, preco, botao(p.preco > 0n ? "Mudar preço" : "Pôr à venda", "", (b) => {
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
  if (podeComprar(p)) {
    // Envia ETH junto com a transação (value); o contrato repassa direto ao vendedor
    acoes.push(botao(`Comprar por ${eth(p.preco)} ETH`, "btn-compra", (b) =>
      enviar(`Comprar peixe #${p.id} por ${eth(p.preco)} ETH`, metodos().comprar(p.id), p.preco, b)));
  }
  if (meu && p.etapa === 2) {
    acoes.push(botao("Registrar venda ao consumidor", "", (b) =>
      enviar(`Venda ao consumidor do peixe #${p.id}`, metodos().registrarVendaAoConsumidor(p.id), 0n, b)));
  }
  return acoes;
}

function renderizarEventos() {
  const v = visao();
  $("cardEventos").hidden = v === "visitante";
  $("cardTx").hidden = !estado.conta;
  $("tituloEventos").textContent = v === "fiscal" ? "Eventos do contrato" : "Meus eventos";
  const alvo = $("listaEventos");
  const eventos = v === "fiscal" ? estado.eventos : estado.eventos.filter(eventoEnvolveMim);
  if (!eventos.length) {
    alvo.replaceChildren(el("li", { class: "vazio" }, "Nenhum evento ainda."));
    return;
  }
  const recentes = [...eventos].reverse().slice(0, MAX_EVENTOS_NA_TELA);
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
    case "ManejoAutorizado":
      return `Manejo autorizado para ${nomeDe(v.comunidade)}: ${v.adultosContados} adultos, cota de ${v.limite} peixes.`;
    case "PeixeRegistrado":
      return `Peixe #${v.id} (lacre ${v.lacre}) pescado por ${nomeDe(v.comunidade)}: `
        + `${metros(Number(v.comprimentoCm))} m, ${kg(Number(v.pesoGramas))} kg.`;
    case "PeixeAVenda":
      return `Peixe #${v.id} posto à venda por ${nomeDe(v.vendedor)} por ${eth(v.preco)} ETH.`;
    case "PeixeVendido":
      // diferenca é int256: pode ser negativa quando o vendedor vende por menos do que pagou
      return `Peixe #${v.id} vendido de ${nomeDe(v.vendedor)} para ${nomeDe(v.comprador)} `
        + `por ${eth(v.valor)} ETH (${ETAPAS[Number(v.novaEtapa)].toLowerCase()}). `
        + `Diferença para o vendedor: ${ethComSinal(v.diferenca)} ETH.`;
    case "VendidoAoConsumidor":
      return `Peixe #${v.id} vendido ao consumidor por ${nomeDe(v.mercado)}.`;
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
  // Com várias contas conectadas, mostra qual delas assinou
  const de = el("div", { class: "tx-de" }, avatar(estado.conta, "pequeno"), `por ${rotuloConta(estado.conta).nome}`);
  const item = el("li", {}, el("div", { class: "tx-topo" }, el("span", {}, descricao), status), de, detalhe);
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
  ApenasFiscalizador: () => "Só o fiscalizador (quem implantou o contrato) pode fazer isso.",
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
  PeixeNaoEstaAVenda: (a) => `O peixe #${a.id} não está à venda.`,
  ValorIncorreto: (a) => `Valor incorreto: o preço é ${eth(a.esperado)} ETH e foram enviados ${eth(a.enviado)} ETH.`,
  FalhaNoPagamento: (a) => `O pagamento de ${eth(a.valor)} ETH para ${nomeDe(a.vendedor)} falhou; a compra foi desfeita.`,
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
// Dados on-chain também são entrada não confiável: nomes, lacres e locais
// foram digitados por alguém. Por isso a tela é montada com
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

// Nome para textos corridos (eventos, detalhes do peixe), com "(você)" na conta ativa
function nomeDe(endereco) {
  if (!endereco) return "–";
  const { nome } = rotuloConta(endereco);
  return eMeu(endereco) ? `${nome} (você)` : nome;
}

function eth(wei) {
  const valor = Number(Web3.utils.fromWei(BigInt(wei).toString(), "ether"));
  return valor.toLocaleString("pt-BR", { maximumFractionDigits: 6 });
}

// int256 do contrato (pode ser negativo): mostra o sinal explicitamente
function ethComSinal(wei) {
  const v = BigInt(wei);
  return `${v < 0n ? "−" : "+"}${eth(v < 0n ? -v : v)}`;
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
