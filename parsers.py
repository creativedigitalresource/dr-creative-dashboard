import re
from datetime import date, datetime


def strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()


def parse_date_field(label: str, text: str, year: int | None = None) -> str | None:
    """Extract a date like 'PDD: 6/15' or 'HDD: 6/15' from text. Returns ISO date string."""
    pattern = rf"{label}\s*:?\s*(\d{{1,2}})/(\d{{1,2}})"
    m = re.search(pattern, text, re.IGNORECASE)
    if not m:
        return None
    y = year or date.today().year
    try:
        d = date(y, int(m.group(1)), int(m.group(2)))
        # Roll year forward if the date is more than 6 months in the past
        if (d - date.today()).days < -180:
            d = date(y + 1, int(m.group(1)), int(m.group(2)))
        return d.isoformat()
    except ValueError:
        return None


def parse_hdd(text: str) -> str | None:
    return parse_date_field("HDD", text)


def parse_pdd(text: str) -> str | None:
    return parse_date_field("PDD", text)


def parse_est(text: str) -> float | None:
    """Extract EST hours from text like 'EST: 3' or 'EST: 1.5'."""
    m = re.search(r"EST\s*:?\s*(\d+\.?\d*)", text, re.IGNORECASE)
    return float(m.group(1)) if m else None


def parse_revs(text: str) -> float:
    """Extract REVS hours. Returns 0 if not found."""
    m = re.search(r"REV[S]?\s*:?\s*(\d+\.?\d*)", text, re.IGNORECASE)
    return float(m.group(1)) if m else 0.0


def parse_todo_fields(title: str, comments: list[dict]) -> dict:
    """
    Extract PDD, HDD, EST, REVS from a todo's title and comment thread.
    Comments should be dicts with 'content' and 'creator.name' keys.
    Manager names are checked first (most authoritative source).
    """
    MANAGER_NAMES = {"richard", "richard vargas", "rich", "brittney", "brittney davis"}

    combined_title = strip_html(title)

    pdd = parse_pdd(combined_title)
    hdd = parse_hdd(combined_title)
    est = parse_est(combined_title)
    revs = parse_revs(combined_title)

    for comment in comments:
        creator = (comment.get("creator") or {}).get("name", "").lower()
        text = strip_html(comment.get("content", ""))

        # Manager comments are authoritative for EST/REVS
        if any(n in creator for n in MANAGER_NAMES):
            if est is None:
                est = parse_est(text)
            if revs == 0:
                revs = parse_revs(text)

        # HDD/PDD can come from any comment but prefer title
        if hdd is None:
            hdd = parse_hdd(text)
        if pdd is None:
            pdd = parse_pdd(text)

    return {
        "pdd": pdd,
        "hdd": hdd,
        "est": est,
        "revs": revs,
        "total_hours": (est or 0) + revs,
    }
