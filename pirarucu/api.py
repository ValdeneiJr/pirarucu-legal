"""Camada de apresentação (HTTP): a API do nó da blockchain local.

Esta camada só traduz HTTP <-> serviço. Quem decide as regras é o contrato.

Para rodar:
    uv run uvicorn pirarucu.api:create_app --factory
"""

import logging
import os

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from pirarucu.database import Database
from pirarucu.errors import AuthenticationError, CorruptedChainError, NotFoundError, PermissionDenied, RuleViolation
from pirarucu.participants import DEMO_PARTICIPANTS
from pirarucu.service import LedgerService

logger = logging.getLogger("pirarucu")


class TransactionRequest(BaseModel):
    # A validação dos valores fica no contrato
    operation: str
    data: dict


def create_app(db_path=None, difficulty=None):
    db_path = db_path or os.environ.get("DB_PATH", "data/pirarucu.db")
    difficulty = difficulty or int(os.environ.get("DIFFICULTY", "4"))

    # Monta as camadas: banco -> serviço -> API
    database = Database(db_path)
    database.seed_participants(DEMO_PARTICIPANTS)
    try:
        service = LedgerService(database, difficulty)
    except CorruptedChainError as error:
        # O nó não sobe com a corrente adulterada
        raise SystemExit(f"\n[ERRO] O nó não vai iniciar. {error}\n"
                         f"Confira o banco em {db_path}. Para começar do zero, apague esse arquivo.\n") from None

    app = FastAPI(title="Pirarucu Legal - nó da blockchain local")

    # Cada erro vira um código HTTP
    for error, status_code in [(AuthenticationError, 401), (PermissionDenied, 403),
                               (RuleViolation, 400), (NotFoundError, 404)]:
        app.add_exception_handler(error, _error_handler(status_code))
    # Qualquer outro erro vira 500, e o detalhe vai para o log
    app.add_exception_handler(Exception, _unexpected_error_handler)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/participants")
    def list_participants():
        return service.list_participants()

    @app.post("/transactions", status_code=201)
    def submit_transaction(request: TransactionRequest, x_token: str = Header(default="")):
        block, mining_seconds = service.submit_transaction(x_token, request.operation, request.data)
        return {"message": "Transação confirmada e gravada na blockchain.",
                "block": block.to_dict(), "mining_seconds": round(mining_seconds, 3)}

    @app.get("/state")
    def get_state():
        return service.get_state()

    @app.get("/fish/{tag}")
    def get_fish(tag: str):
        return service.get_fish(tag)

    @app.get("/chain")
    def get_chain():
        return service.get_chain()

    @app.post("/simulate-tampering/{index}")
    def simulate_tampering(index: int):
        return service.simulate_tampering(index)

    return app


def _error_handler(status_code):
    async def handler(_request: Request, error: Exception):
        return JSONResponse(status_code=status_code, content={"detail": str(error)})
    return handler


async def _unexpected_error_handler(_request: Request, error: Exception):
    logger.exception("Erro inesperado no nó", exc_info=error)
    return JSONResponse(status_code=500,
                        content={"detail": "Erro interno no nó. Nada foi gravado; tente de novo."})
