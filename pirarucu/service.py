"""Camada de negócio: o fluxo do nó (enviar transações e consultar a blockchain e o estado do contrato).

Fluxo de uma transação (submit_transaction):
    token -> identifica o remetente
    contract.validate() -> se quebrar alguma regra, a transação é rejeitada e nada é gravado
    bloco novo com a transação -> mineração (prova de trabalho) -> entra na corrente
    contract.apply() -> o estado muda (cota, dono do peixe)
    o bloco é salvo no banco
"""

import copy
import logging
import threading
import time

from pirarucu.blockchain import Blockchain
from pirarucu.contract import PirarucuContract
from pirarucu.errors import AuthenticationError, CorruptedChainError, NotFoundError, TransactionRejected

logger = logging.getLogger("pirarucu")


class LedgerService:
    def __init__(self, database, difficulty):
        self.db = database
        self.lock = threading.Lock()  # uma transação por vez
        self.contract = PirarucuContract({p["id"]: p for p in database.list_participants()})
        self.chain = self._load_chain(difficulty)

    # Inicialização

    def _load_chain(self, difficulty):
        saved = self.db.list_blocks()
        if not saved:
            # Primeira execução: cria a corrente com o bloco gênesis
            chain = Blockchain(difficulty)
            self.db.add_block(chain.latest_block())
            self.db.set_setting("difficulty", difficulty)
            return chain

        # A dificuldade é da corrente: vale a que foi usada para minerar os blocos salvos
        stored = self.db.get_setting("difficulty")
        if stored is None:
            self.db.set_setting("difficulty", difficulty)
        else:
            if not stored.isdigit() or int(stored) < 1:
                raise CorruptedChainError(f"A dificuldade salva no banco é inválida: {stored!r}.")
            if int(stored) != difficulty:
                logger.warning("A corrente salva usa dificuldade %s; ignorando a dificuldade %s pedida.",
                               stored, difficulty)
                difficulty = int(stored)

        chain = Blockchain(difficulty, saved)
        invalid = chain.first_invalid_block()
        if invalid is not None:
            raise CorruptedChainError(f"A blockchain salva no banco foi adulterada (bloco #{invalid}).")

        # Reconstrói o estado do contrato aplicando todas as transações da corrente, em ordem
        for block in chain.blocks[1:]:
            tx = block.data
            try:
                self.contract.execute(tx["sender"], tx["operation"], tx["data"])
            except TransactionRejected as error:
                raise CorruptedChainError(f"O bloco #{block.index} tem uma transação inválida: {error}") from error
            except (KeyError, TypeError, AttributeError) as error:
                raise CorruptedChainError(f"O bloco #{block.index} tem uma transação malformada.") from error
        return chain

    # Escrita

    def authenticate(self, token):
        participant = self.db.find_participant_by_token(token or "")
        if participant is None:
            raise AuthenticationError("Token inválido: participante não identificado.")
        return participant

    def submit_transaction(self, token, operation, data):
        sender = self.authenticate(token)
        with self.lock:
            data = self.contract.validate(sender["id"], operation, data)

            transaction = {"operation": operation, "sender": sender["id"], "data": data}
            block = self.chain.new_block(transaction)
            start = time.perf_counter()
            self.chain.add_block(block)  # minera o bloco
            mining_seconds = time.perf_counter() - start

            try:
                self.db.add_block(block)
            except Exception:
                # Desfaz na memória para continuar igual ao banco
                self.chain.blocks.pop()
                raise
            self.contract.apply(sender["id"], operation, data)
            return block, mining_seconds

    # Consultas

    def list_participants(self):
        return self.db.list_participants()

    # Leituras usam a trava e devolvem cópias

    def get_state(self):
        with self.lock:
            return copy.deepcopy(self.contract.state())

    def get_fish(self, tag):
        tag = tag.strip().upper()
        with self.lock:
            fish = copy.deepcopy(self.contract.fish.get(tag))
            history = [block.to_dict() for block in self.chain.blocks[1:] if block.data["data"].get("tag") == tag]
        if fish is None:
            raise NotFoundError(f"Nenhum peixe registrado com o lacre {tag}.")
        return {"fish": fish, "history": history}

    def get_chain(self):
        # A corrente inteira é validada na inicialização (o nó não sobe se estiver adulterada)
        with self.lock:
            blocks = [block.to_dict() for block in self.chain.blocks]
        return {"difficulty": self.chain.difficulty, "blocks": blocks}

    def simulate_tampering(self, index):
        """Altera os dados de um bloco numa CÓPIA da corrente e mostra que a validação detecta.
        A blockchain verdadeira não é modificada."""
        if index < 1 or index >= len(self.chain.blocks):
            raise NotFoundError("Escolha um bloco com transação (do #1 ao último).")
        with self.lock:
            tampered = self.chain.copy()
        block = tampered.blocks[index]
        data = block.data["data"]
        if "quota" in data:
            data["quota"] += 1000
        elif "length_m" in data:
            data["length_m"] = 1.00
        else:
            data["recipient"] = "frig-tefe" if data["recipient"] == "merc-manaus" else "merc-manaus"
        return {"tampered_block": block.to_dict(),
                "recalculated_hash": block.calculate_hash(),
                "valid": tampered.is_valid(),
                "first_invalid_block": tampered.first_invalid_block()}
