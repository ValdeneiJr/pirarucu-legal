"""Todos os erros da aplicação. As mensagens aparecem para o usuário, por isso ficam em português.

Na API, cada erro vira um código HTTP (veja api.py).
"""


class TransactionRejected(Exception):
    """A transação foi recusada pelo contrato e não entra na blockchain."""


class PermissionDenied(TransactionRejected):
    """Quem enviou a transação não tem permissão para fazer essa operação. (HTTP 403)"""


class RuleViolation(TransactionRejected):
    """Os dados da transação quebram alguma regra de negócio. (HTTP 400)"""


class AuthenticationError(Exception):
    """O token enviado não pertence a nenhum participante. (HTTP 401)"""


class NotFoundError(Exception):
    """O item consultado não existe. (HTTP 404)"""


class CorruptedChainError(Exception):
    """A blockchain salva no banco foi adulterada: o nó não deve iniciar."""
