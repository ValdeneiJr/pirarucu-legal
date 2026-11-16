"""Camada de apresentação (telas): a interface do Pirarucu Legal em Streamlit.

A interface não guarda nada e não acessa o banco: ela só conversa com o nó pela API HTTP.

Para rodar (com o nó já rodando):
    uv run streamlit run pirarucu/ui.py
"""

import os
from datetime import datetime
from urllib.parse import quote

import requests
import streamlit as st

from pirarucu.participants import DEMO_PARTICIPANTS

API_URL = os.environ.get("API_URL", "http://localhost:8000")
REFRESH_SECONDS = 3  # intervalo das atualizações automáticas das abas Estado e Blockchain
INVALID_TOKEN = "__invalid__"
TOKENS = {p["id"]: p["token"] for p in DEMO_PARTICIPANTS}  # a "carteira" de cada participante
OPERATION_LABELS = {
    "authorize_fishing": "Autorizar manejo",
    "register_catch": "Registrar captura",
    "transfer": "Transferir peixe",
}
ROLE_LABELS = {
    "inspector": "Fiscalizador",
    "community": "Comunidade de manejo",
    "processor": "Frigorífico",
    "market": "Mercado",
}

st.set_page_config(page_title="Pirarucu Legal", page_icon="🐟", layout="wide")


# Funções de apoio

def call_api(method, path, body=None, token="", timeout=10):
    """Chama o nó e devolve sempre (código HTTP, corpo), sem lançar exceção.
    Quando o nó não responde, o código é None e o corpo explica o motivo."""
    try:
        response = requests.request(method, f"{API_URL}{path}", json=body,
                                    headers={"X-Token": token}, timeout=timeout)
    except requests.ConnectionError:
        return None, {"detail": f"O nó da blockchain em {API_URL} está fora do ar. Nada foi enviado."}
    except requests.Timeout:
        return None, {"detail": "O nó demorou demais para responder. "
                                "Confira na aba Blockchain se a operação entrou antes de tentar de novo."}
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, {"detail": f"Resposta inesperada do nó (HTTP {response.status_code})."}


def api_get(path):
    return call_api("GET", path)


def node_error(body):
    st.warning(f"🔌 {body['detail']}")


def name(participant_id):
    return participants.get(participant_id, {}).get("name", participant_id)


def short_name(participant_id):
    return name(participant_id).split(" (")[0]


def format_datetime(timestamp_ms):
    return datetime.fromtimestamp(timestamp_ms / 1000).strftime("%d/%m/%Y %H:%M:%S")


def format_number(value, decimals):
    return f"{value:.{decimals}f}".replace(".", ",")


def describe(transaction):
    data = transaction["data"]
    sender = name(transaction["sender"])
    if transaction["operation"] == "authorize_fishing":
        return f"{sender} autorizou {name(data['community'])} com cota de {data['quota']} peixes"
    if transaction["operation"] == "register_catch":
        return (f"{sender} registrou o peixe {data['tag']} ({format_number(data['length_m'], 2)} m, "
                f"{format_number(data['weight_kg'], 1)} kg, {data['location']})")
    return f"{sender} transferiu o peixe {data['tag']} para {name(data['recipient'])}"


def submit(token, operation, data):
    # Recarrega a página para todas as abas lerem a corrente atualizada; o nó minera antes de responder
    st.session_state["result"] = call_api("POST", "/transactions", {"operation": operation, "data": data},
                                          token, timeout=120)
    st.rerun()


def show_result():
    if "result" not in st.session_state:
        return
    status, body = st.session_state.pop("result")

    if status == 201:
        block = body["block"]
        st.success(f"✅ {body['message']}")
        st.markdown(f"**Bloco #{block['index']}** minerado em {format_number(body['mining_seconds'], 3)} s "
                    f"(nonce {block['nonce']:,})".replace(",", "."))
        st.code(f"hash:          {block['hash']}\nhash anterior: {block['previous_hash']}", language=None)
        return

    detail = body.get("detail")
    if status is None:
        node_error(body)
        return
    if status == 403:
        st.error(f"🚫 **Sem permissão:** {detail}")
    elif status == 401:
        st.error(f"🔑 **Não autenticado:** {detail}")
    elif status == 400:
        st.error(f"❌ **Rejeitada pelo contrato:** {detail}")
    elif status >= 500:
        st.error(f"⚠️ **Erro no nó:** {detail}")
    else:
        st.error(f"Erro {status}: {detail}")
    st.caption("Nada foi gravado na blockchain.")


# Conexão com o nó

status_participants, participants_body = api_get("/participants")
status_chain, chain = api_get("/chain")
if status_participants != 200 or status_chain != 200:
    body = participants_body if status_participants != 200 else chain
    st.error(f"Não foi possível carregar os dados do nó: {body['detail']}")
    st.info("Inicie o nó com `uv run uvicorn pirarucu.api:create_app --factory` "
            "(ou `docker compose up -d`) e recarregue a página.")
    st.stop()
participants = {p["id"]: p for p in participants_body}


# Barra lateral: quem está usando e situação do nó

st.sidebar.title("🐟 Pirarucu Legal")
st.sidebar.caption("Rastreabilidade do pirarucu de manejo com blockchain local")

identity = st.sidebar.selectbox(
    "Quem é você?", list(participants) + [INVALID_TOKEN],
    format_func=lambda i: "🚫 Participante não cadastrado" if i == INVALID_TOKEN else name(i))

if identity == INVALID_TOKEN:
    token = "fake-token"
    st.sidebar.warning("Usando um token que não existe (para testar a rejeição).")
else:
    token = TOKENS.get(identity, "")
    st.sidebar.info(f"Papel: **{ROLE_LABELS[participants[identity]['role']]}**")

st.sidebar.divider()
st.sidebar.markdown("**Nó da blockchain local**")
st.sidebar.markdown(f"🟢 Online em `{API_URL}`")
st.sidebar.markdown(f"Blocos: **{len(chain['blocks'])}** · Dificuldade: **{chain['difficulty']}**")
st.sidebar.success("Corrente validada na inicialização")


# Partes que se atualizam sozinhas

@st.fragment(run_every=REFRESH_SECONDS)
def show_state():
    status, state = api_get("/state")
    if status != 200:
        node_error(state)
        return

    st.subheader("Cotas das comunidades")
    if not state["quotas"]:
        st.info("Nenhuma comunidade autorizada ainda.")
    for community, quota in state["quotas"].items():
        st.markdown(f"**{name(community)}**: {quota['caught']} de {quota['quota']} peixes "
                    f"({quota['remaining']} restantes)")
        st.progress(quota["caught"] / quota["quota"])

    st.subheader("Peixes registrados")
    if not state["fish"]:
        st.info("Nenhum peixe registrado ainda.")
    else:
        st.dataframe(
            [{"Lacre": f["tag"], "Comprimento (m)": f["length_m"], "Peso (kg)": f["weight_kg"],
              "Local": f["location"], "Origem": name(f["community"]), "Dono atual": name(f["owner"])}
             for f in state["fish"].values()],
            hide_index=True, width="stretch")


@st.fragment(run_every=REFRESH_SECONDS)
def show_blocks():
    status, chain = api_get("/chain")
    if status != 200:
        node_error(chain)
        return
    col1, col2 = st.columns(2)
    col1.metric("Blocos", len(chain["blocks"]))
    col2.metric("Dificuldade (zeros no início do hash)", chain["difficulty"])

    for block in reversed(chain["blocks"]):
        with st.container(border=True):
            if block["index"] == 0:
                st.markdown(f"**Bloco #0 · gênesis** · {format_datetime(block['timestamp'])}")
            else:
                st.markdown(f"**Bloco #{block['index']} · {OPERATION_LABELS[block['data']['operation']]}** "
                            f"· {format_datetime(block['timestamp'])}")
                st.write(describe(block["data"]))
            st.code(f"hash:          {block['hash']}\n"
                    f"hash anterior: {block['previous_hash']}\n"
                    f"nonce:         {block['nonce']}", language=None)
            if block["index"] > 0:
                with st.expander("Dados gravados no bloco"):
                    st.json(block["data"])


# Abas

tab_submit, tab_query, tab_state, tab_chain = st.tabs(
    ["📝 Registrar", "🔎 Consultar lacre", "📊 Estado do contrato", "⛓️ Blockchain"])

with tab_submit:
    st.header("Enviar uma transação")
    st.caption("A transação vai para o contrato inteligente. Se passar em todas as regras, "
               "ela é minerada num bloco novo. Se não passar, é rejeitada e nada é gravado.")

    operation = st.radio("Operação", list(OPERATION_LABELS), format_func=OPERATION_LABELS.get, horizontal=True)

    if operation == "authorize_fishing":
        st.caption("Quem pode: **fiscalizador**. Libera a comunidade e define quantos peixes ela pode pescar.")
        communities = [i for i, p in participants.items() if p["role"] == "community"]
        with st.form("authorize"):
            community = st.selectbox("Comunidade", communities, format_func=name)
            quota = st.number_input("Cota (quantidade de peixes)", min_value=0, value=10, step=1)
            if st.form_submit_button("Autorizar", type="primary"):
                submit(token, operation, {"community": community, "quota": quota})

    elif operation == "register_catch":
        st.caption("Quem pode: **comunidade autorizada**. Tamanho mínimo de 1,50 m, "
                   "lacre único e sem passar da cota.")
        with st.form("catch"):
            tag = st.text_input("Número do lacre", placeholder="Ex.: AM-000123")
            col1, col2 = st.columns(2)
            length = col1.number_input("Comprimento (m)", min_value=0.0, value=1.80, step=0.05, format="%.2f")
            weight = col2.number_input("Peso (kg)", min_value=0.0, value=60.0, step=1.0, format="%.1f")
            location = st.text_input("Lago / local da pesca", placeholder="Ex.: Lago Mamirauá")
            if st.form_submit_button("Registrar captura", type="primary"):
                submit(token, operation, {"tag": tag, "length_m": length, "weight_kg": weight, "location": location})

    else:
        st.caption("Quem pode: **dono atual do peixe**. Ordem: comunidade → frigorífico → mercado.")
        with st.form("transfer"):
            tag = st.text_input("Número do lacre", placeholder="Ex.: AM-000123")
            recipient = st.selectbox("Destinatário", list(participants), format_func=name)
            if st.form_submit_button("Transferir", type="primary"):
                submit(token, operation, {"tag": tag, "recipient": recipient})

    show_result()

with tab_query:
    st.header("Consultar a origem de um peixe")
    st.caption("Qualquer pessoa (inclusive o consumidor) pode consultar pelo número do lacre.")
    search = st.text_input("Número do lacre ", placeholder="Ex.: AM-000123")
    if search:
        status, result = api_get(f"/fish/{quote(search.strip(), safe='')}")
        if status not in (200, 404):
            node_error(result)
        elif status == 404:
            st.warning(f"Nenhum peixe registrado com o lacre {search.strip().upper()}.")
        else:
            fish = result["fish"]
            st.success(f"Peixe **{fish['tag']}** encontrado na blockchain.")
            col1, col2, col3, col4 = st.columns(4)
            col1.metric("Comprimento", f"{format_number(fish['length_m'], 2)} m")
            col2.metric("Peso", f"{format_number(fish['weight_kg'], 1)} kg")
            col3.metric("Origem", short_name(fish["community"]))
            col4.metric("Está com", short_name(fish["owner"]))
            st.markdown(f"**Local da pesca:** {fish['location']}")

            st.subheader("Histórico (cada linha é um bloco)")
            for block in result["history"]:
                with st.container(border=True):
                    st.markdown(f"**Bloco #{block['index']}** · {format_datetime(block['timestamp'])}")
                    st.write(describe(block["data"]))
                    st.caption(f"hash {block['hash']}")

with tab_state:
    st.header("Estado atual do contrato")
    st.caption("O estado é calculado aplicando, em ordem, todas as transações gravadas na blockchain. "
               f"Atualiza sozinho a cada {REFRESH_SECONDS} s.")
    show_state()

with tab_chain:
    st.header("Blockchain local")
    st.caption(f"Atualiza sozinha a cada {REFRESH_SECONDS} s.")
    show_blocks()

    st.divider()
    st.subheader("🧪 E se alguém adulterar um bloco?")
    st.caption("Altera os dados de um bloco numa cópia da corrente e roda a validação. "
               "A blockchain verdadeira não é modificada.")
    if len(chain["blocks"]) < 2:
        st.info("Registre ao menos uma transação para testar.")
    else:
        index = st.selectbox("Bloco a adulterar", range(1, len(chain["blocks"])), format_func=lambda i: f"Bloco #{i}")
        if st.button("Adulterar e validar"):
            status, result = call_api("POST", f"/simulate-tampering/{index}")
            if status != 200:
                node_error(result)
                st.stop()
            block = result["tampered_block"]
            st.markdown("**Dados depois da alteração:**")
            st.json(block["data"]["data"])
            st.code(f"hash gravado no bloco: {block['hash']}\n"
                    f"hash dos dados agora:  {result['recalculated_hash']}", language=None)
            st.error(f"❌ A validação detectou a adulteração no bloco #{result['first_invalid_block']}: "
                     "o hash dos dados não bate mais com o hash gravado.")
