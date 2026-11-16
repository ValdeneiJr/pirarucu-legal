// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Pirarucu Legal - rastreabilidade do pirarucu de manejo
/// @author Equipe Pirarucu Legal
/// @notice Registra cada pirarucu de manejo, do lago ao mercado. O fiscalizador
///         cadastra os participantes e autoriza as comunidades com uma cota. A
///         comunidade registra cada peixe pelo lacre, e o peixe segue pela cadeia
///         (comunidade -> frigorífico -> mercado), vendido com pagamento em ETH.
/// @dev As regras seguem o Decreto estadual do Amazonas nº 36.083/2015: cota de
///      no máximo 30% dos adultos contados, tamanho mínimo de 1,50 m e lacre
///      individual numerado.
contract PirarucuLegal {
    // [Recurso: StructsEEnums]
    /// @notice Papel de cada conta na cadeia. Nenhum = conta não cadastrada.
    enum Papel {
        Nenhum,
        Comunidade,
        Frigorifico,
        Mercado
    }

    /// @notice Etapa (estado) do peixe. É a máquina de estados do contrato.
    enum Etapa {
        NaComunidade,
        NoFrigorifico,
        NoMercado,
        VendidoAoConsumidor
    }

    /// @notice Conta cadastrada pelo fiscalizador.
    struct Participante {
        string nome;
        Papel papel;
    }

    /// @notice Cota de pesca de uma comunidade (30% dos adultos contados).
    struct Cota {
        uint256 adultosContados;
        uint256 limite;
        uint256 capturados;
    }

    /// @notice Registro de um pirarucu, do lago ao mercado.
    struct Peixe {
        uint256 id;
        string lacre;
        address comunidade;
        address dono;
        uint256 comprimentoCm;
        uint256 pesoGramas;
        string local;
        uint256 preco; // preço de venda em wei; 0 = não está à venda
        uint256 valorPago; // quanto o dono atual pagou pelo peixe
        Etapa etapa;
        uint256 capturadoEm;
    }

    // [Recurso: TiposDeDados]
    /// @notice Fiscalizador: quem implantou o contrato. É o dono e não muda.
    address public immutable fiscalizador;

    /// @notice Tamanho mínimo do decreto: 1,50 m.
    uint256 public constant TAMANHO_MINIMO_CM = 150;
    /// @notice Acima disso é erro de digitação.
    uint256 public constant TAMANHO_MAXIMO_CM = 300;
    /// @notice Peso máximo aceito: 200 kg.
    uint256 public constant PESO_MAXIMO_G = 200_000;
    /// @notice Cota do decreto: 30% dos adultos contados.
    uint256 public constant PERCENTUAL_COTA = 30;
    /// @notice Limite do laço de listagem.
    uint256 public constant MAX_POR_PAGINA = 50;
    /// @notice Tamanho mínimo e máximo do lacre.
    uint256 public constant TAMANHO_MIN_LACRE = 3;
    uint256 public constant TAMANHO_MAX_LACRE = 20;
    /// @notice Tamanho máximo de nome e local.
    uint256 public constant TAMANHO_MAX_TEXTO = 60;

    /// @notice Soma de todo o ETH já negociado na cadeia.
    uint256 public totalNegociadoWei;

    // [Recurso: ArraysEMappings]
    /// @dev Array dinâmico: o índice é o id do peixe.
    Peixe[] private peixes;

    /// @notice Mapping -> struct: dados de cada participante.
    mapping(address => Participante) public participantes;

    /// @notice Mapping -> struct: cota de cada comunidade.
    mapping(address => Cota) public cotas;

    /// @dev Mapping simples: hash do lacre (bytes32) -> id + 1. O zero indica "lacre livre".
    mapping(bytes32 => uint256) private idMaisUmPorLacre;

    // [Recurso: EventosEErros]
    event ParticipanteCadastrado(address indexed conta, Papel papel, string nome);
    event ManejoAutorizado(address indexed comunidade, uint256 adultosContados, uint256 limite);
    event PeixeRegistrado(
        uint256 indexed id,
        address indexed comunidade,
        string lacre,
        uint256 comprimentoCm,
        uint256 pesoGramas
    );
    event PeixeAVenda(uint256 indexed id, address indexed vendedor, uint256 preco);
    /// @param diferenca Preço de venda menos o que o vendedor pagou. Negativo = venda com prejuízo.
    event PeixeVendido(
        uint256 indexed id,
        address indexed vendedor,
        address indexed comprador,
        uint256 valor,
        int256 diferenca,
        Etapa novaEtapa
    );
    event VendidoAoConsumidor(uint256 indexed id, address indexed mercado);

    error ApenasFiscalizador(address chamador);
    error PapelInvalido(Papel esperado, Papel atual);
    error ParticipanteJaCadastrado(address conta);
    error ComunidadeNaoAutorizada(address comunidade);
    error CotaEsgotada(uint256 capturados, uint256 limite);
    error CotaMenorQueCapturados(uint256 novoLimite, uint256 capturados);
    error LacreInvalido(string lacre);
    error LacreJaUsado(string lacre);
    error LacreNaoEncontrado(string lacre);
    error TamanhoForaDaFaixa(uint256 informadoCm, uint256 minimoCm, uint256 maximoCm);
    error PesoInvalido(uint256 informadoG, uint256 maximoG);
    error PeixeInexistente(uint256 id);
    error NaoEDonoDoPeixe(uint256 id, address chamador);
    error EtapaInvalida(uint256 id, Etapa atual, Etapa esperada);
    error PeixeNaoNegociavel(uint256 id, Etapa atual);
    error PeixeNaoEstaAVenda(uint256 id);
    error ValorIncorreto(uint256 esperado, uint256 enviado);
    error FalhaNoPagamento(address vendedor, uint256 valor);

    // [Recurso: Modificadores]
    /// @dev Controle de acesso do dono: só o fiscalizador.
    modifier apenasFiscalizador() {
        if (msg.sender != fiscalizador) revert ApenasFiscalizador(msg.sender);
        _;
    }

    /// @dev Modificador com parâmetro: exige um papel específico.
    modifier apenasPapel(Papel papel) {
        _exigirPapel(msg.sender, papel);
        _;
    }

    /// @dev O id precisa ser de um peixe registrado.
    modifier peixeExiste(uint256 id) {
        if (id >= peixes.length) revert PeixeInexistente(id);
        _;
    }

    /// @dev O peixe precisa existir e pertencer a quem chama.
    modifier apenasDonoDoPeixe(uint256 id) {
        if (id >= peixes.length) revert PeixeInexistente(id);
        if (peixes[id].dono != msg.sender) revert NaoEDonoDoPeixe(id, msg.sender);
        _;
    }

    /// @dev Modificador com parâmetro: o peixe precisa estar na etapa indicada.
    modifier noEstado(uint256 id, Etapa etapa) {
        Etapa atual = peixes[id].etapa;
        if (atual != etapa) revert EtapaInvalida(id, atual, etapa);
        _;
    }

    // [Recurso: Funcoes] - constructor
    /// @notice Quem implanta o contrato vira o fiscalizador.
    constructor() {
        fiscalizador = msg.sender;
    }

    /// @notice Cadastra uma conta como comunidade, frigorífico ou mercado.
    /// @dev Um papel não pode ser trocado depois, para ninguém "mudar de lado".
    /// @param conta Endereço da carteira do participante.
    /// @param papel Papel (1 = Comunidade, 2 = Frigorífico, 3 = Mercado).
    /// @param nome Nome do participante (1 a 60 caracteres).
    function cadastrarParticipante(address conta, Papel papel, string calldata nome)
        external
        apenasFiscalizador
    {
        // [Recurso: EstruturasDeControle] - require
        require(conta != address(0), "Conta invalida");
        require(conta != fiscalizador, "O fiscalizador nao pode ter outro papel");
        require(papel != Papel.Nenhum, "Escolha um papel");
        require(_textoValido(nome), "Nome deve ter de 1 a 60 caracteres");
        if (participantes[conta].papel != Papel.Nenhum) revert ParticipanteJaCadastrado(conta);

        participantes[conta] = Participante({nome: nome, papel: papel});
        emit ParticipanteCadastrado(conta, papel, nome);
    }

    /// @notice Autoriza o manejo de uma comunidade a partir da contagem de adultos.
    /// @dev A cota é sempre 30% dos adultos contados (calcularCota). Pode ser
    ///      chamada de novo para atualizar a contagem, sem ficar abaixo do já pescado.
    /// @param comunidade Endereço de uma conta com papel Comunidade.
    /// @param adultosContados Pirarucus adultos contados no lago.
    function autorizarManejo(address comunidade, uint256 adultosContados) external apenasFiscalizador {
        _exigirPapel(comunidade, Papel.Comunidade);

        uint256 limite = calcularCota(adultosContados);
        require(limite > 0, "Poucos adultos contados: a cota daria zero");

        Cota storage cota = cotas[comunidade];
        if (limite < cota.capturados) revert CotaMenorQueCapturados(limite, cota.capturados);

        cota.adultosContados = adultosContados;
        cota.limite = limite;
        emit ManejoAutorizado(comunidade, adultosContados, limite);
    }

    /// @notice A comunidade registra um pirarucu pescado.
    /// @param lacre Número do lacre (3 a 20 caracteres: A-Z, 0-9 e hífen).
    /// @param comprimentoCm Comprimento em centímetros (150 a 300).
    /// @param pesoGramas Peso em gramas (1 a 200.000).
    /// @param local Lago ou local da pesca (1 a 60 caracteres).
    /// @return id Id do peixe registrado.
    function registrarCaptura(
        string calldata lacre,
        uint256 comprimentoCm,
        uint256 pesoGramas,
        string calldata local
    ) external apenasPapel(Papel.Comunidade) returns (uint256 id) {
        Cota storage cota = cotas[msg.sender];
        // [Recurso: EstruturasDeControle] - if
        if (cota.limite == 0) revert ComunidadeNaoAutorizada(msg.sender);
        if (cota.capturados >= cota.limite) revert CotaEsgotada(cota.capturados, cota.limite);

        _validarLacre(lacre);
        // [Recurso: TiposDeDados] - bytes32 como chave única do lacre
        bytes32 chave = hashDoLacre(lacre);
        if (idMaisUmPorLacre[chave] != 0) revert LacreJaUsado(lacre);

        _validarMedidas(comprimentoCm, pesoGramas);
        require(_textoValido(local), "Local deve ter de 1 a 60 caracteres");

        cota.capturados += 1;
        id = peixes.length;
        Peixe storage peixe = peixes.push();
        peixe.id = id;
        peixe.lacre = lacre;
        peixe.comunidade = msg.sender;
        peixe.dono = msg.sender;
        peixe.comprimentoCm = comprimentoCm;
        peixe.pesoGramas = pesoGramas;
        peixe.local = local;
        peixe.capturadoEm = block.timestamp;
        idMaisUmPorLacre[chave] = id + 1;
        emit PeixeRegistrado(id, msg.sender, lacre, comprimentoCm, pesoGramas);
    }

    /// @notice O dono põe o peixe à venda para a próxima etapa da cadeia.
    /// @dev Chamar de novo troca o preço.
    /// @param id Id do peixe.
    /// @param precoWei Preço em wei (maior que zero).
    function colocarAVenda(uint256 id, uint256 precoWei) external apenasDonoDoPeixe(id) {
        Peixe storage peixe = peixes[id];
        if (_proximoPapel(peixe.etapa) == Papel.Nenhum) revert PeixeNaoNegociavel(id, peixe.etapa);
        require(precoWei > 0, "O preco deve ser maior que zero");

        peixe.preco = precoWei;
        emit PeixeAVenda(id, msg.sender, precoWei);
    }

    /// @notice Compra um peixe à venda, pagando o preço exato em ETH.
    /// @dev Só o próximo papel da cadeia compra: frigorífico compra da comunidade e
    ///      mercado compra do frigorífico. O ETH vai direto para o vendedor, seguindo
    ///      checks-effects-interactions: confere tudo, atualiza o estado e só então
    ///      transfere. Se o envio falhar, a compra inteira é desfeita.
    /// @param id Id do peixe.
    // [Recurso: Funcoes] - external payable: recebe ETH
    function comprar(uint256 id) external payable peixeExiste(id) {
        Peixe storage peixe = peixes[id];

        // [Recurso: EstruturasDeControle] - checks-effects-interactions
        // checks
        if (peixe.preco == 0) revert PeixeNaoEstaAVenda(id);
        _exigirPapel(msg.sender, _proximoPapel(peixe.etapa));
        if (msg.value != peixe.preco) revert ValorIncorreto(peixe.preco, msg.value);

        // effects
        address vendedor = peixe.dono;
        // [Recurso: TiposDeDados] - int (com sinal): a diferença pode ser negativa
        int256 diferenca = int256(msg.value) - int256(peixe.valorPago);
        Etapa novaEtapa = peixe.etapa == Etapa.NaComunidade ? Etapa.NoFrigorifico : Etapa.NoMercado;
        peixe.dono = msg.sender;
        peixe.preco = 0;
        peixe.valorPago = msg.value;
        peixe.etapa = novaEtapa;
        totalNegociadoWei += msg.value;
        emit PeixeVendido(id, vendedor, msg.sender, msg.value, diferenca, novaEtapa);

        // interactions
        // [Recurso: TiposDeDados] - address payable recebe o pagamento
        address payable recebedor = payable(vendedor);
        (bool ok, ) = recebedor.call{value: msg.value}("");
        if (!ok) revert FalhaNoPagamento(vendedor, msg.value);
    }

    /// @notice O mercado registra a venda ao consumidor final. Fim da cadeia.
    /// @param id Id do peixe (precisa estar no mercado).
    function registrarVendaAoConsumidor(uint256 id)
        external
        apenasDonoDoPeixe(id)
        noEstado(id, Etapa.NoMercado)
    {
        peixes[id].etapa = Etapa.VendidoAoConsumidor;
        emit VendidoAoConsumidor(id, msg.sender);
    }

    /// @notice Quantidade de peixes registrados.
    // [Recurso: Funcoes] - funções view (só leem o estado)
    function totalPeixes() external view returns (uint256) {
        return peixes.length;
    }

    /// @notice Dados de um peixe pelo número do lacre. Qualquer pessoa pode consultar.
    /// @param lacre Número do lacre.
    function consultarPorLacre(string calldata lacre) external view returns (Peixe memory) {
        uint256 idMaisUm = idMaisUmPorLacre[hashDoLacre(lacre)];
        if (idMaisUm == 0) revert LacreNaoEncontrado(lacre);
        return peixes[idMaisUm - 1];
    }

    /// @notice Lista peixes em páginas de no máximo MAX_POR_PAGINA.
    /// @param inicio Id do primeiro peixe da página.
    /// @param quantidade Quantos peixes trazer (limitado a MAX_POR_PAGINA).
    function listarPeixes(uint256 inicio, uint256 quantidade) external view returns (Peixe[] memory pagina) {
        uint256 total = peixes.length;
        if (inicio >= total) return new Peixe[](0);
        if (quantidade > MAX_POR_PAGINA) quantidade = MAX_POR_PAGINA;

        uint256 fim = inicio + quantidade;
        if (fim > total) fim = total;

        pagina = new Peixe[](fim - inicio);
        // [Recurso: EstruturasDeControle] - laço com limite controlado (até 50 voltas)
        for (uint256 i = inicio; i < fim; i++) {
            pagina[i - inicio] = peixes[i];
        }
    }

    /// @notice Cota permitida para uma contagem de adultos (30%, arredondado para baixo).
    /// @param adultosContados Pirarucus adultos contados.
    // [Recurso: Funcoes] - public pure (usada pelo contrato e pelo frontend)
    function calcularCota(uint256 adultosContados) public pure returns (uint256) {
        return (adultosContados * PERCENTUAL_COTA) / 100;
    }

    /// @notice Chave bytes32 de um lacre, usada para garantir que ele é único.
    /// @param lacre Número do lacre.
    function hashDoLacre(string calldata lacre) public pure returns (bytes32) {
        return keccak256(bytes(lacre));
    }

    /// @dev internal: confere comprimento e peso do peixe.
    // [Recurso: Funcoes] - internal
    function _validarMedidas(uint256 comprimentoCm, uint256 pesoGramas) internal pure {
        if (comprimentoCm < TAMANHO_MINIMO_CM || comprimentoCm > TAMANHO_MAXIMO_CM) {
            revert TamanhoForaDaFaixa(comprimentoCm, TAMANHO_MINIMO_CM, TAMANHO_MAXIMO_CM);
        }
        if (pesoGramas == 0 || pesoGramas > PESO_MAXIMO_G) revert PesoInvalido(pesoGramas, PESO_MAXIMO_G);
    }

    /// @dev internal: a conta precisa ter exatamente o papel esperado.
    function _exigirPapel(address conta, Papel esperado) internal view {
        Papel atual = participantes[conta].papel;
        if (atual != esperado) revert PapelInvalido(esperado, atual);
    }

    /// @dev private: nome e local têm de 1 a TAMANHO_MAX_TEXTO bytes.
    // [Recurso: Funcoes] - private
    function _textoValido(string calldata texto) private pure returns (bool) {
        uint256 n = bytes(texto).length;
        return n > 0 && n <= TAMANHO_MAX_TEXTO;
    }

    /// @dev private: o lacre só aceita A-Z, 0-9 e hífen. O laço vai até 20 voltas.
    function _validarLacre(string calldata lacre) private pure {
        bytes calldata b = bytes(lacre);
        if (b.length < TAMANHO_MIN_LACRE || b.length > TAMANHO_MAX_LACRE) revert LacreInvalido(lacre);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            // [Recurso: TiposDeDados] - bool
            bool valido = (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "-";
            if (!valido) revert LacreInvalido(lacre);
        }
    }

    /// @dev private: quem pode comprar o peixe em cada etapa.
    // [Recurso: EstruturasDeControle] - if / else if / else
    function _proximoPapel(Etapa etapa) private pure returns (Papel) {
        if (etapa == Etapa.NaComunidade) {
            return Papel.Frigorifico;
        } else if (etapa == Etapa.NoFrigorifico) {
            return Papel.Mercado;
        } else {
            return Papel.Nenhum;
        }
    }
}
