// Pirarucu Legal - constantes do frontend: rede, textos dos enums e limites.
// Carregado antes do app.js (veja index.html).
"use strict";

// Rede Sepolia
const SEPOLIA = {
  chainId: "0xaa36a7", // 11155111
  rpcPublico: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
};

// Textos dos enums do contrato, na mesma ordem (Papel e Etapa)
const PAPEIS = ["Sem papel", "Comunidade", "Frigorífico", "Mercado"];
const ETAPAS = ["Na comunidade", "No frigorífico", "No mercado", "Vendido ao consumidor"];

// Regras iguais às do contrato
const POR_PAGINA = 50; // MAX_POR_PAGINA
const PERCENTUAL_COTA = 30; // PERCENTUAL_COTA

// Leitura de eventos
const PASSO_EVENTOS = 5000; // blocos por consulta de eventos
const JANELA_SEM_BLOCO_DEPLOY = 50000; // se blocoDeploy não foi configurado
const MAX_EVENTOS_NA_TELA = 100;

// Transações e avisos
const FOLGA_GAS_PERCENTUAL = 20n; // somado à estimativa de gas
const TEMPO_AVISO_MS = 4500;
const TEMPO_AVISO_ERRO_MS = 7000;

// Texto do aviso quando a MetaMask não abre a tela para conectar mais contas
const DICA_MAIS_CONTAS = "Para incluir contas, abra a MetaMask, clique no ícone de site conectado (no topo) "
  + "e marque as contas em \"Editar contas\". Ou selecione a outra conta na MetaMask e aceite conectá-la ao site.";
