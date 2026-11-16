"""Contrato inteligente do pirarucu de manejo.

O contrato é o conjunto de regras de negócio que decide se uma transação pode
entrar na blockchain. Ele tem três operações:

1. authorize_fishing - o fiscalizador libera uma comunidade e define a cota de peixes.
2. register_catch    - a comunidade registra um peixe pescado, identificado pelo lacre.
3. transfer          - o dono atual passa o peixe adiante: comunidade -> frigorífico -> mercado.

O estado do contrato (cotas e donos de cada peixe) não é guardado à parte: ele é
o resultado de aplicar, em ordem, todas as transações que estão na blockchain.
"""

import math
import re

from pirarucu.errors import PermissionDenied, RuleViolation
from pirarucu.participants import COMMUNITY, INSPECTOR, MARKET, PROCESSOR

MIN_LENGTH_M = 1.50   # tamanho mínimo de captura do pirarucu no manejo
MAX_LENGTH_M = 3.00   # acima disso, o valor é considerado erro de digitação
MAX_WEIGHT_KG = 200
MAX_QUOTA = 10_000
TAG_FORMAT = re.compile(r"^[A-Z0-9-]{3,20}$")  # formato do lacre

# Para quem cada papel pode transferir o peixe (a ordem da cadeia)
NEXT_IN_CHAIN = {COMMUNITY: PROCESSOR, PROCESSOR: MARKET}

# Como cada papel aparece nas mensagens para o usuário
ROLE_LABELS = {INSPECTOR: "fiscalizador", COMMUNITY: "comunidade", PROCESSOR: "frigorífico", MARKET: "mercado"}

OPERATIONS = ("authorize_fishing", "register_catch", "transfer")


class PirarucuContract:
    def __init__(self, participants):
        self.participants = participants  # id -> {"id", "name", "role"}
        self.quotas = {}  # id da comunidade -> {"quota": int, "caught": int}
        self.fish = {}    # lacre -> dados do peixe e dono atual

    # Entrada principal

    def validate(self, sender, operation, data):
        """Confere a transação sem mudar nada. Devolve os dados já limpos
        (é isso que vai para o bloco) ou lança TransactionRejected."""
        if sender not in self.participants:
            raise PermissionDenied("Remetente desconhecido.")
        if operation not in OPERATIONS:
            raise RuleViolation(f"Operação desconhecida: {operation}.")
        if not isinstance(data, dict):
            raise RuleViolation("Os dados da transação devem ser um objeto.")
        return getattr(self, f"_validate_{operation}")(sender, data)

    def apply(self, sender, operation, data):
        """Muda o estado do contrato. Só deve ser chamado com dados que já passaram por validate()."""
        getattr(self, f"_apply_{operation}")(sender, data)

    def execute(self, sender, operation, data):
        data = self.validate(sender, operation, data)
        self.apply(sender, operation, data)
        return data

    def role(self, participant_id):
        return self.participants[participant_id]["role"]

    # 1. authorize_fishing

    def _validate_authorize_fishing(self, sender, data):
        if self.role(sender) != INSPECTOR:
            raise PermissionDenied("Só o órgão fiscalizador pode autorizar o manejo.")

        community = _text(data.get("community"), "comunidade")
        if community not in self.participants or self.role(community) != COMMUNITY:
            raise RuleViolation("A comunidade informada não existe.")

        quota = _integer(data.get("quota"), "cota")
        if quota < 1 or quota > MAX_QUOTA:
            raise RuleViolation(f"A cota deve ficar entre 1 e {MAX_QUOTA} peixes.")

        caught = self.quotas.get(community, {}).get("caught", 0)
        if quota < caught:
            raise RuleViolation(f"A cota não pode ser menor que os {caught} peixes que a comunidade já capturou.")

        return {"community": community, "quota": quota}

    def _apply_authorize_fishing(self, sender, data):
        current = self.quotas.get(data["community"], {"caught": 0})
        self.quotas[data["community"]] = {"quota": data["quota"], "caught": current["caught"]}

    # 2. register_catch

    def _validate_register_catch(self, sender, data):
        if self.role(sender) != COMMUNITY:
            raise PermissionDenied("Só uma comunidade de manejo pode registrar captura.")
        if sender not in self.quotas:
            raise PermissionDenied("Esta comunidade ainda não foi autorizada pelo fiscalizador.")

        tag = _text(data.get("tag"), "lacre").upper()
        if not TAG_FORMAT.match(tag):
            raise RuleViolation("Lacre inválido: use de 3 a 20 letras, números ou hífen.")
        if tag in self.fish:
            raise RuleViolation(f"O lacre {tag} já foi usado em outro peixe.")

        length = _number(data.get("length_m"), "comprimento")
        if length < MIN_LENGTH_M:
            raise RuleViolation(
                f"Peixe com {_br(length)} m está abaixo do tamanho mínimo de {_br(MIN_LENGTH_M)} m.")
        if length > MAX_LENGTH_M:
            raise RuleViolation(f"Comprimento de {_br(length)} m não é possível para um pirarucu.")

        weight = _number(data.get("weight_kg"), "peso")
        if weight <= 0 or weight > MAX_WEIGHT_KG:
            raise RuleViolation(f"O peso deve ser maior que 0 e no máximo {MAX_WEIGHT_KG} kg.")

        location = _text(data.get("location"), "local")
        if not location or len(location) > 60:
            raise RuleViolation("Informe o lago ou local da pesca (até 60 caracteres).")

        quota = self.quotas[sender]
        if quota["caught"] >= quota["quota"]:
            raise RuleViolation(f"Cota esgotada: a comunidade já capturou {quota['caught']} de {quota['quota']} peixes.")

        return {"tag": tag, "length_m": length, "weight_kg": weight, "location": location}

    def _apply_register_catch(self, sender, data):
        self.quotas[sender]["caught"] += 1
        self.fish[data["tag"]] = {
            "tag": data["tag"],
            "community": sender,
            "length_m": data["length_m"],
            "weight_kg": data["weight_kg"],
            "location": data["location"],
            "owner": sender,
        }

    # 3. transfer

    def _validate_transfer(self, sender, data):
        tag = _text(data.get("tag"), "lacre").upper()
        if tag not in self.fish:
            raise RuleViolation(f"Não existe peixe registrado com o lacre {tag or '(vazio)'}.")

        if self.fish[tag]["owner"] != sender:
            raise PermissionDenied("Só o dono atual do peixe pode transferi-lo.")

        next_role = NEXT_IN_CHAIN.get(self.role(sender))
        if next_role is None:
            raise RuleViolation("O peixe já chegou ao fim da cadeia (mercado) e não pode mais ser transferido.")

        recipient = _text(data.get("recipient"), "destinatário")
        if recipient not in self.participants:
            raise RuleViolation("O destinatário informado não existe.")
        if self.role(recipient) != next_role:
            raise RuleViolation(
                f"Ordem da cadeia: quem é {ROLE_LABELS[self.role(sender)]} só pode transferir "
                f"para um {ROLE_LABELS[next_role]}.")

        return {"tag": tag, "recipient": recipient}

    def _apply_transfer(self, sender, data):
        self.fish[data["tag"]]["owner"] = data["recipient"]

    # Consulta do estado

    def state(self):
        quotas = {
            community: {**quota, "remaining": quota["quota"] - quota["caught"]}
            for community, quota in self.quotas.items()
        }
        return {"quotas": quotas, "fish": self.fish}


def _br(number):
    # 1.5 -> "1,50"
    return f"{number:.2f}".replace(".", ",")


def _text(value, name):
    # Campo ausente vira texto vazio; outros tipos são recusados
    if value is None:
        return ""
    if not isinstance(value, str):
        raise RuleViolation(f"O campo {name} deve ser um texto.")
    return value.strip()


def _number(value, name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise RuleViolation(f"O {name} deve ser um número.") from None
    if isinstance(value, bool) or not math.isfinite(number):
        raise RuleViolation(f"O {name} deve ser um número.")
    if abs(number - round(number, 2)) > 1e-9:
        raise RuleViolation(f"O {name} deve ter no máximo 2 casas decimais.")
    return round(number, 2)


def _integer(value, name):
    if isinstance(value, bool):
        raise RuleViolation(f"A {name} deve ser um número inteiro.")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise RuleViolation(f"A {name} deve ser um número inteiro.") from None
    if not math.isfinite(number) or not number.is_integer():
        raise RuleViolation(f"A {name} deve ser um número inteiro.")
    return int(number)
