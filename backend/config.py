from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # External metadata / subtitle providers.
    TMDB_API_KEY: str = ""
    OPENSUBTITLES_API_KEY: str = ""
    SUBDL_API_KEY: str = ""

    # Local NetWatch services.
    TORRENT_ENGINE_URL: str = "http://localhost:8081"
    PROWLARR_URL: str = "http://localhost:9696"
    PROWLARR_API_KEY: str = ""
    FLARESOLVERR_URL: str = "http://127.0.0.1:8191"
    PROWLARR_SEARCH_TIMEOUT_SECS: float = 25.0
    DEPENDENCY_TIMEOUT_SECS: float = 4.0

    # Ephemeral torrent/video storage shared with the torrent engine.
    TEMP_DOWNLOAD_DIR: str = "/tmp/netwatch"

    # Optional persistent catalog cache. Compose points this at NetWatch's
    # persistent data area so Home survives backend/app restarts.
    NETWATCH_CACHE_DIR: str = ""


settings = Settings()
