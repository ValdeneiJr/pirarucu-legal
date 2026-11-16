FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /bin/uv

WORKDIR /app

# Instala as dependências e o projeto (sem as de desenvolvimento)
COPY pyproject.toml uv.lock README.md ./
COPY pirarucu ./pirarucu
RUN uv sync --locked --no-dev

# Roda sem root; /data guarda o banco (volume do compose)
RUN useradd --create-home pirarucu && mkdir /data && chown pirarucu /data
USER pirarucu

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false

# O comando de cada serviço (nó ou interface) fica no compose.yaml
