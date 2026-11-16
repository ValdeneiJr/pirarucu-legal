# 🐟 Pirarucu Legal

Rastreabilidade do **pirarucu de manejo** da Amazônia com uma **blockchain local** e um **contrato inteligente**.

Trabalho da AP1 de Oficina 3.

---

## 1. O problema

O pirarucu (*Arapaima gigas*) é um dos maiores peixes de escamas de água doce do planeta ([Exame, 2022](https://exame.com/negocios/netzero/pirarucu-amazonia-case-bem-sucedido/)). O pirarucu vendido sem comprovação de origem continua aparecendo no Amazonas:

- **Tefé, setembro de 2024:** uma operação do Ibama apreendeu 422 kg de carne de pirarucu que estaria sendo vendida na Feira Municipal, sem comprovação de procedência de manejo autorizado ([Agência Brasil, via Poder360](https://www.poder360.com.br/poder-sustentavel/seca-de-rios-favorece-caca-e-pesca-ilegais-na-amazonia/)).
- **Vale do Javari, 2019:** uma multa recorde de R$ 10 milhões pelo transporte ilegal de 2 toneladas de pirarucu. Desde 1998, foram 47 autuações por pesca, transporte ou venda de pirarucu em cinco municípios da região ([Agência Pública](https://apublica.org/2022/06/vale-do-javari-teve-multa-recorde-por-pesca-ilegal-de-pirarucu-no-amazonas/)).
- **Concorrência desleal:** a venda ilegal aparece entre os principais desafios para vender o pirarucu manejado das reservas Mamirauá e Amanã ([Amaral, Revista Uakari, 2007](https://mamiraua.org.br/wp-content/uploads/2025/11/A-Comunidade-e-o-Mercado-os-desafios-na-comercializacao-de-pirarucu-manejado-das-Reservas-Mamiraua-e-Amana-Amazonas-Brasil.pdf)).

### O que a legislação exige

A pesca do pirarucu é regulamentada pelas Instruções Normativas do IBAMA nº 34/2004 (bacia do rio Amazonas) e nº 1/2005 (Amazonas). No Amazonas, a pesca manejada segue o [Decreto estadual nº 36.083/2015](https://www.legisweb.com.br/legislacao/?id=287404), que exige:

- pesca só de acordo com a autorização expedida;
- **cota** de no máximo 30% dos adultos contados, e adulto é o peixe com **1,50 m** ou mais;
- **lacre individual numerado** em cada peixe;
- venda do peixe inteiro condicionada ao lacre e às guias de transporte e de comercialização.

Em 2025, a Portaria IBAMA nº 22 criou o Programa Arapaima, que tem entre os objetivos "garantir a rastreabilidade para monitoramento, controle e exportação da espécie" ([Portal Amazônia](https://portalamazonia.com/amazonas/ibama-arapaima-pirarucu-amazonas/)).

### O que já existe

- A marca **Gosto da Amazônia**, da Asproc, foi a primeira experiência de rastreabilidade da cadeia no estado, em 2020, com QR Code para acompanhar o peixe da pesca até o supermercado ([Exame, 2022](https://exame.com/negocios/netzero/pirarucu-amazonia-case-bem-sucedido/)).
- O aplicativo **Gygas**, da Fundação Amazônia Sustentável, funciona em áreas de baixa conectividade, usa blockchain e dá um QR Code a cada peixe. O projeto atende 55 manejadores em três comunidades da RDS Mamirauá ([Portal Amazônia, 2025](https://portalamazonia.com/amazonas/aplicativo-cpf-pirarucu-rastrear/)).

Este trabalho é uma versão didática. O foco é aplicar as regras do manejo num contrato inteligente, que rejeita as operações inválidas antes de gravar.

## 2. A solução

O **Pirarucu Legal** registra toda a vida do peixe numa blockchain:

1. o **órgão fiscalizador** autoriza a comunidade e define a cota;
2. a **comunidade** registra cada peixe pescado, com lacre, tamanho, peso e lago;
3. o peixe é **transferido** pela cadeia: comunidade → frigorífico → mercado;
4. **qualquer pessoa** consulta o lacre e vê a origem e todo o caminho do peixe.

Um **contrato inteligente** confere as regras do manejo antes de qualquer registro entrar na blockchain.

## 3. Por que blockchain?

| Necessidade | Como a blockchain atende |
|---|---|
| Vários participantes (comunidade, fiscalizador, frigorífico e mercado) que não confiam totalmente uns nos outros | Todos seguem o mesmo registro, e ninguém é "dono" da planilha |
| Um registro não pode ser alterado nem apagado depois | Cada bloco guarda o hash do anterior. Mudar um registro quebra a corrente, e a validação detecta |
| As regras precisam valer igual para todos | O contrato inteligente aplica as mesmas regras a todas as transações, sem exceção |
| Rastreabilidade completa | O histórico de cada lacre é a sequência de blocos que falam dele |

Um banco de dados comum resolveria o armazenamento. Mas quem administra o banco pode alterar um registro sem deixar rastro. Na blockchain, qualquer alteração aparece.


## 4. Arquitetura

O código está em 3 camadas, e cada camada só conhece a de baixo:

```
┌───────────────────────────────────────────────────────────────┐
│ APRESENTAÇÃO   ui.py (Streamlit)  ── HTTP ──►  api.py (FastAPI)│
└───────────────────────────────────────────────┬───────────────┘
┌───────────────────────────────────────────────▼───────────────┐
│ NEGÓCIO        service.py   fluxo: autenticar → validar →     │
│                             minerar → salvar → aplicar        │
│                contract.py  o contrato inteligente (regras)   │
│                blockchain.py a blockchain da aula             │
└───────────────────────────────────────────────┬───────────────┘
┌───────────────────────────────────────────────▼───────────────┐
│ DADOS          database.py  SQLite: blocos e participantes    │
└───────────────────────────────────────────────────────────────┘
```

| Arquivo (`pirarucu/`) | Camada | Papel |
|---|---|---|
| `ui.py` | apresentação | as telas. Não acessa o banco: só chama a API |
| `api.py` | apresentação | as rotas HTTP. Transforma cada erro num código HTTP |
| `service.py` | negócio | o fluxo de uma transação e as consultas |
| `contract.py` | negócio | o **contrato inteligente** |
| `blockchain.py` | negócio | blocos, hash, mineração e validação (a blockchain da aula) |
| `database.py` | dados | o SQLite |
| `participants.py` | — | os papéis e os usuários da demonstração (o seed dos participantes) |
| `errors.py` | — | todos os erros da aplicação |

O código está em inglês, e os comentários e os textos que o usuário vê estão em português.

### O caminho de uma transação

1. Na interface, o usuário escolhe quem ele é e preenche a operação. A interface chama `POST /transactions` com o token no cabeçalho `X-Token`.
2. O serviço procura o dono do token no banco. Se o token não existir, a resposta é **401**.
3. O **contrato valida** a transação:
   - sem permissão → **403**, e nada é gravado;
   - alguma regra quebrada → **400**, e nada é gravado.
4. Se passou, a transação vira um **bloco novo**, que é **minerado**: o nó procura um nonce que deixe o hash começando com `0000`.
5. O bloco é **salvo no SQLite**, e o contrato **aplica** a transação: a cota diminui ou o dono do peixe muda.

Uma trava faz o nó processar uma transação por vez. Se a gravação no banco falhar, o bloco também é desfeito na memória.

### O que fica no SQLite

| Tabela | O que é | Proteção |
|---|---|---|
| `blocks` | a blockchain, com um bloco por linha e a transação em JSON | gatilhos bloqueiam `UPDATE` e `DELETE`: a tabela só cresce |
| `participants` | quem pode enviar transações: nome, papel e **hash** do token | o token em si nunca é salvo |
| `settings` | configurações da corrente, como a dificuldade usada na mineração | — |

A dificuldade também fica salva no banco: se o nó reiniciar com outro `DIFFICULTY`, ele avisa no log e continua com a dificuldade da corrente.

Na primeira execução, o nó cadastra os participantes de `participants.py` no banco. A partir daí, a autenticação e a lista de participantes vêm do banco. A blockchain começa vazia, só com o bloco gênese (#0).

As **cotas e os donos dos peixes não ficam no banco**. Quando o nó inicia, ele lê os blocos, **confere a corrente de hashes** e **reexecuta todas as transações** no contrato para reconstruir o estado. Se alguém adulterar o banco "na mão" (remover os gatilhos e editar um bloco, por exemplo), o hash não bate e o **nó se recusa a iniciar**. O banco é só onde os blocos ficam guardados, e a fonte da verdade continua sendo a corrente de hashes.

### Rotas da API

| Rota | Para quê |
|---|---|
| `POST /transactions` | enviar uma operação ao contrato |
| `GET /state` | cotas e peixes atuais |
| `GET /fish/{tag}` | um peixe e o seu histórico, com os blocos que citam o lacre |
| `GET /chain` | todos os blocos e a dificuldade da corrente |
| `POST /simulate-tampering/{index}` | adultera um bloco numa **cópia** da corrente e mostra a detecção |
| `GET /participants` | participantes, sem os tokens |
| `GET /health` | usado pelo Docker para saber se o nó está no ar |

A documentação interativa fica em http://localhost:8000/docs.

## 5. O contrato inteligente

| Operação | Quem pode | Regras |
|---|---|---|
| `authorize_fishing` | Fiscalizador | A comunidade precisa existir. A cota fica entre 1 e 10.000 e não pode ser menor que o que a comunidade já pescou. |
| `register_catch` | Comunidade **autorizada** | Lacre com 3 a 20 caracteres (letras, números e hífen) e **único**. Comprimento de **1,50 m** a 3,00 m. Peso maior que 0 e até 200 kg. Local preenchido. **A cota não pode estar esgotada.** |
| `transfer` | **Dono atual** do peixe | O lacre precisa existir. A cadeia segue a ordem **comunidade → frigorífico → mercado**, sem pular etapa. O mercado é o fim da cadeia. |

Cada operação tem um `_validate_*`, que confere sem mudar nada, e um `_apply_*`, que muda o estado. Essa separação garante que **uma transação rejeitada não deixa rastro**. As rejeições são de dois tipos:
- **`PermissionDenied`**: por exemplo, o frigorífico tenta autorizar uma comunidade, uma comunidade não autorizada tenta registrar um peixe ou alguém tenta transferir um peixe que não é seu.
- **`RuleViolation`**: por exemplo, peixe pequeno, lacre repetido, cota esgotada ou tentativa de pular uma etapa da cadeia.

## 6. Quais dados ficam na blockchain

Cada bloco guarda **uma transação**:

```json
{
  "index": 2,
  "timestamp": 1790617957933,
  "previous_hash": "00004e04a49f…",
  "nonce": 86425,
  "hash": "0000b1c2…",
  "data": {
    "operation": "register_catch",
    "sender": "com-boa-esperanca",
    "data": { "tag": "AM-000101", "length_m": 1.92, "weight_kg": 74.5, "location": "Lago Mamirauá" }
  }
}
```

**Ficam na blockchain (tabela `blocks`):**
- a operação, quem a fez e os dados dela: lacre, medidas, lago, cota e destinatário;
- os campos que garantem a integridade: índice, data e hora, hash anterior, nonce e hash.

**Não ficam na blockchain:**
- **Os tokens.** Eles ficam fora da corrente, na tabela `participants`, e só o hash deles é salvo.
- **O estado calculado** (cotas restantes e dono atual). Ele é derivado das transações e recalculado a cada inicialização.
- **As transações rejeitadas.** Elas não passaram no contrato.
- **Dados pessoais dos pescadores** (nome e CPF). A blockchain não pode ser apagada, então guardar dados pessoais nela seria um problema com a LGPD. Por isso, a comunidade aparece só por um identificador.

## 7. Como rodar

### Com Docker

```bash
docker compose up --build -d                      # sobe o nó e a interface
```

- **Interface:** http://localhost:8501
- **API:** http://localhost:8000/docs

| Comando | O que faz |
|---|---|
| `docker compose logs -f node` | acompanha o nó; cada transação aparece aqui |
| `docker compose down` | para tudo; a blockchain continua salva no volume |
| `docker compose down -v` | para tudo e **apaga** a blockchain |

O compose tem dois serviços:
- **`node`**: guarda o banco num volume e tem um healthcheck.
- **`ui`**: só sobe depois que o nó responde.

### Sem Docker (com o [uv](https://docs.astral.sh/uv/))

```bash
uv run uvicorn pirarucu.api:create_app --factory   # terminal 1: nó em http://localhost:8000
uv run streamlit run pirarucu/ui.py                # terminal 2: interface em http://localhost:8501
```

O banco fica em `data/pirarucu.db`. Para começar do zero, pare o nó e apague a pasta `data/`.

## 8. Limitações e próximos passos

- **Um nó só.** Uma blockchain real teria vários nós, um em cada participante, com um consenso entre eles.
  - A detecção de adulteração pega quem edita um bloco no banco. Mas com dificuldade 4, quem tiver acesso ao arquivo consegue **reminerar a corrente inteira** em poucos segundos, e ela volta a parecer válida.
  - Numa rede real, isso não adianta: os outros nós têm cópias independentes e recusam a corrente alterada. Essa proteção só existe com vários nós.
- **Regras fixas.** Mudar uma regra do contrato (por exemplo, o tamanho mínimo) invalida a corrente antiga, porque a reexecução passa a recusar transações que antes eram aceitas. Blockchains reais resolvem isso versionando o contrato.
- **Autenticação por token.** O certo seria cada participante assinar as transações com a sua chave privada (assinatura digital).
- **Participantes pré-cadastrados.** O cadastro poderia ser uma operação do próprio contrato.
- **Sem safras.** A cota não é separada por safra ou ano.
- **Cota digitada.** O fiscalizador informa a cota pronta. O sistema não registra a contagem nem limita a cota a 30% dos adultos contados, como manda o decreto.
- **Sem guias.** As guias de transporte e de comercialização não são registradas nas transferências.
- **Ideia futura:** gerar um QR Code a partir do lacre para o consumidor consultar direto na peixaria.
