"""A blockchain local: blocos ligados pelo hash do anterior, com prova de trabalho.

É a blockchain apresentada em aula. Ela não sabe nada de banco de dados:
salvar e carregar os blocos é trabalho do database.py.
"""

import copy
import hashlib
import json
import time


class Block:
    """Um bloco guarda dados e o hash do bloco anterior (é isso que forma a "corrente")."""

    def __init__(self, index, timestamp, previous_hash, data, nonce=0, block_hash=None):
        self.index = index
        self.timestamp = timestamp
        self.previous_hash = previous_hash
        self.data = data
        self.nonce = nonce
        # Bloco vindo do banco mantém o hash salvo, para a validação conferir
        self.hash = block_hash if block_hash is not None else self.calculate_hash()

    def calculate_hash(self):
        # SHA-256 de todos os campos; os dados viram JSON com chaves ordenadas para o hash ser estável
        data = json.dumps(self.data, sort_keys=True, ensure_ascii=False)
        text = f"{self.index}{self.timestamp}{self.previous_hash}{data}{self.nonce}"
        return hashlib.sha256(text.encode()).hexdigest()

    def proof_of_work(self, difficulty):
        # "Minerar": muda o nonce até o hash começar com `difficulty` zeros
        self.nonce = 0
        self.hash = self.calculate_hash()
        while not self.hash.startswith("0" * difficulty):
            self.nonce += 1
            self.hash = self.calculate_hash()

    def to_dict(self):
        return {"index": self.index, "timestamp": self.timestamp, "previous_hash": self.previous_hash,
                "data": self.data, "nonce": self.nonce, "hash": self.hash}


class Blockchain:
    """Uma lista de blocos, onde cada bloco aponta para o anterior."""

    def __init__(self, difficulty, blocks=None):
        self.difficulty = difficulty
        if blocks:
            # Corrente já existente (carregada do banco)
            self.blocks = list(blocks)
        else:
            # Corrente nova: cria o primeiro bloco (bloco gênesis), que não tem anterior
            genesis = Block(0, now_ms(), None, "Genesis block")
            genesis.proof_of_work(difficulty)
            self.blocks = [genesis]

    def latest_block(self):
        return self.blocks[-1]

    def new_block(self, data):
        # Cria um bloco ligado ao último bloco da corrente; o horário nunca volta, mesmo se o relógio atrasar
        latest = self.latest_block()
        return Block(latest.index + 1, max(now_ms(), latest.timestamp), latest.hash, data)

    def add_block(self, block):
        block.proof_of_work(self.difficulty)
        self.blocks.append(block)

    def is_first_block_valid(self):
        first = self.blocks[0]
        if first.index != 0:
            return False
        if first.previous_hash is not None:
            return False
        if first.hash != first.calculate_hash():
            return False
        if not first.hash.startswith("0" * self.difficulty):
            return False
        return True

    def is_valid_new_block(self, new, previous):
        if new is None or previous is None:
            return False
        if new.index != previous.index + 1:
            return False
        if new.previous_hash != previous.hash:
            return False
        if new.timestamp < previous.timestamp:
            return False
        if new.hash != new.calculate_hash():
            return False
        # Confere se o bloco foi realmente minerado (prova de trabalho)
        if not new.hash.startswith("0" * self.difficulty):
            return False
        return True

    def first_invalid_block(self):
        # Devolve o índice do primeiro bloco com problema, ou None se a corrente estiver íntegra
        if not self.is_first_block_valid():
            return 0
        for i in range(1, len(self.blocks)):
            if not self.is_valid_new_block(self.blocks[i], self.blocks[i - 1]):
                return i
        return None

    def is_valid(self):
        return self.first_invalid_block() is None

    def copy(self):
        return copy.deepcopy(self)


def now_ms():
    return int(time.time() * 1000)
