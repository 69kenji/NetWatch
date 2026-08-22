from __future__ import annotations

import math
import re
from datetime import date
from typing import Iterable

# Keep the safety filter high-confidence. Mature ratings, nudity, violence,
# "adult animation", or erotic-thriller metadata are not sufficient on their own.
# These terms are intended to identify pornography / hentai rather than mature cinema.
_EXPLICIT_KEYWORD_FRAGMENTS = (
    "hentai",
    "softcore",
    "hardcore pornography",
    "pornographic animation",
    "erotic animation",
    "adult video",
)
_EXPLICIT_TEXT_RE = re.compile(
    r"\b(?:hentai|softcore|hardcore\s+porn(?:ography)?)\b",
    re.IGNORECASE,
)

# For Recent shelves only: if a production is exclusively from one of these
# clearly Asian markets, NetWatch keeps Japan and South Korea and omits the
# others. Unknown-country items and multinational productions with any non-listed
# country remain eligible so indie and international co-productions are not lost.
_RESTRICTED_ASIA = {
    "AF", "BH", "BD", "BT", "BN", "KH", "CN", "HK", "IN", "ID", "IR",
    "IQ", "IL", "JO", "KZ", "KW", "KG", "LA", "LB", "MO", "MY", "MV",
    "MN", "MM", "NP", "KP", "OM", "PK", "PS", "PH", "QA", "SA", "SG",
    "LK", "SY", "TW", "TJ", "TH", "TL", "TM", "AE", "UZ", "VN", "YE",
}
_ALLOWED_ASIA = {"JP", "KR"}


def normalize_keywords(values: Iterable[str]) -> set[str]:
    return {" ".join(str(value or "").strip().casefold().split()) for value in values if str(value or "").strip()}


def is_explicit_content(
    *,
    adult: bool = False,
    title: str = "",
    overview: str = "",
    keywords: Iterable[str] = (),
) -> bool:
    if adult:
        return True

    keyword_set = normalize_keywords(keywords)
    for keyword in keyword_set:
        if any(fragment in keyword for fragment in _EXPLICIT_KEYWORD_FRAGMENTS):
            return True

    # Only strong textual signals are considered; generic sexual/mature terms are
    # intentionally ignored to avoid filtering legitimate mature films or TV.
    searchable = f"{title}\n{overview}"
    return bool(_EXPLICIT_TEXT_RE.search(searchable))


def is_indian_production(countries: Iterable[str]) -> bool:
    """Return True when TMDB identifies India as an origin/production country.

    This is a catalog preference, not a language heuristic: a Hindi-language title
    from another country is not rejected unless TMDB actually associates India with
    the production, while an English-language Indian production is still excluded.
    Any India-listed co-production is excluded as well.
    """
    normalized = {str(country or "").strip().upper() for country in countries if str(country or "").strip()}
    return "IN" in normalized


def recent_origin_allowed(countries: Iterable[str]) -> bool:
    normalized = {str(country or "").strip().upper() for country in countries if str(country or "").strip()}
    if not normalized:
        return True
    if normalized & _ALLOWED_ASIA:
        return True
    # Any country outside the restricted-Asia set makes this an international or
    # non-Asian production, which remains eligible.
    if normalized - _RESTRICTED_ASIA:
        return True
    return False


def recent_score(
    *,
    popularity: float,
    vote_count: int,
    rating: float,
    release_date: str | None,
    today: date,
    trending: bool = False,
    release_types: Iterable[int] = (),
    has_poster: bool = False,
    has_backdrop: bool = False,
) -> float:
    """Rank Recent candidates without hard vote/studio gates.

    Popularity and votes are logarithmic so one blockbuster cannot completely
    dominate the shelf. Freshness helps brand-new releases, while trending and
    theatrical/digital release metadata are bonuses rather than requirements.
    """
    score = 4.5 * math.log1p(max(0.0, float(popularity)))
    score += 2.0 * math.log1p(max(0, int(vote_count)))

    age_days = 120
    if release_date:
        try:
            released = date.fromisoformat(release_date[:10])
            age_days = max(0, (today - released).days)
        except ValueError:
            pass
    freshness = max(0.0, 1.0 - min(age_days, 120) / 120.0)
    score += 5.0 * freshness

    if trending:
        score += 14.0

    types = {int(value) for value in release_types if isinstance(value, (int, float)) or str(value).isdigit()}
    if types & {2, 3}:  # limited theatrical / theatrical
        score += 7.0
    elif 1 in types:  # premiere
        score += 4.0
    elif 4 in types:  # digital
        score += 3.5

    # Rating becomes useful only once at least a modest number of people voted;
    # it is never a minimum threshold.
    if vote_count >= 10:
        score += max(0.0, min(float(rating), 10.0) - 5.0) * 0.55

    if has_poster:
        score += 0.8
    if has_backdrop:
        score += 1.0
    return score
