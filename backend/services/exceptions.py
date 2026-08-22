class DependencyUnavailableError(RuntimeError):
    """Raised when an optional local/external service cannot currently be used."""

    def __init__(self, service: str, message: str):
        self.service = service
        self.message = message
        super().__init__(f"{service}: {message}")
