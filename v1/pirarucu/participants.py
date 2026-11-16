"""Participantes da demonstração (nomes fictícios).

Na primeira execução, o nó cadastra esta lista na tabela `participants` do banco,
guardando só o hash de cada token. A interface usa os tokens para simular cada participante,
como se fosse a "carteira" de cada um.

Simplificação: numa blockchain real, cada participante assinaria as transações
com a sua chave privada. Aqui o token faz o papel dessa chave.
"""

# Papéis
INSPECTOR = "inspector"   # órgão fiscalizador: autoriza o manejo e define a cota
COMMUNITY = "community"   # comunidade de manejo: pesca e registra o peixe
PROCESSOR = "processor"   # frigorífico: recebe e processa o peixe
MARKET = "market"         # mercado: vende ao consumidor (fim da cadeia)

DEMO_PARTICIPANTS = [
    {"id": "fiscalizador", "name": "Órgão Fiscalizador do Manejo",
     "role": INSPECTOR, "token": "token-fiscalizador"},
    {"id": "com-boa-esperanca", "name": "Comunidade Boa Esperança (RDS Mamirauá)",
     "role": COMMUNITY, "token": "token-boa-esperanca"},
    {"id": "com-sao-jose", "name": "Comunidade São José (RDS Amanã)",
     "role": COMMUNITY, "token": "token-sao-jose"},
    {"id": "frig-tefe", "name": "Frigorífico Rio Solimões (Tefé)",
     "role": PROCESSOR, "token": "token-frigorifico"},
    {"id": "merc-manaus", "name": "Peixaria do Mercado Municipal (Manaus)",
     "role": MARKET, "token": "token-mercado"},
]
