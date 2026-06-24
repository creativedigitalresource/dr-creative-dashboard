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


CATEGORIES = [
    "Branding/Logo - Creation/Edits",
    "Print - Collateral/Packaging",
    "Web - Sites/Applications/UI",
    "Web - Maintenance",
    "Email - Campaigns/Signatures",
    "LP - New",
    "LP - Maintenance",
    "Digital - Banner/Display Ads",
    "Multi - Photo/Video/Edits",
    "IPM - Campaigns/Reports",
    "SM - templates/graphics/reels",
    "Misc.",
    "Admin",
]


def categorize_todo(title: str) -> str:
    """Best-guess category from todo title."""
    t = title.lower()

    # Admin — check first, hard skip
    if any(k in t for k in ["meeting hours", "goals", "maternity", "internal tasks",
                              "dr internal", "cowork", "power bi", "check-in"]):
        return "Admin"

    # Misc
    if "misc" in t:
        return "Misc."

    # IPM — must check before email/LP
    if any(k in t for k in ["ipm", "[create outline]", "create outline", "[create to-dos",
                              "create to-dos", "campaign schedule", "campaign calendar",
                              "reporting:"]):
        return "IPM - Campaigns/Reports"

    # Social Media
    if any(k in t for k in ["social media", "[july]", "[june]", "social media content",
                              "birthday/anniversary", "stories"]):
        return "SM - templates/graphics/reels"

    # Video/Multimedia — check before ads
    if any(k in t for k in ["reel", "video", "photo/video", "multimedia", "influencer video",
                              "waiting room video", "voiceover", "careers page video"]):
        return "Multi - Photo/Video/Edits"

    # Digital Ads — check before LP
    if any(k in t for k in ["display", "banner", "programmatic", "pbcso", "ai image",
                              "ai video", "ads request", "creative request", "linkedin ads",
                              "stretch ads", "new video for ads"]):
        return "Digital - Banner/Display Ads"

    # LP - New vs Maintenance
    lp_related = any(k in t for k in ["lp & ty", "lp &amp; ty", " lp ", "landing page",
                                       "lp only", "lp page", "write & design [campaign"])
    if lp_related:
        if any(k in t for k in ["[launch]", "launch -", "write & design", "new lp",
                                  "new emergency", "new general"]):
            return "LP - New"
        return "LP - Maintenance"  # review, edits, revisions

    # Email
    if any(k in t for k in ["email", "newsletter", "[sent]", "[schedule]", "[report] -",
                              "drip", "campaign", "promotion", "signature"]):
        return "Email - Campaigns/Signatures"

    # Web — Sites vs Maintenance
    if any(k in t for k in ["mockup", "hi-fi", "hifi", "wireframe", "sitemap",
                              "sub service page", "aio service page", "[design - phase",
                              "seo –", "seo -"]):
        return "Web - Sites/Applications/UI"

    if any(k in t for k in ["maintenance", "update slug", "cms", "webflow update",
                              "redirect", "revenuewell", "booking widget"]):
        return "Web - Maintenance"

    # Branding/Logo
    if any(k in t for k in ["logo", "brand", "wordmark", "branding", "brand guide",
                              "brand identity", "redesigned logo", "existing logo"]):
        return "Branding/Logo - Creation/Edits"

    # Print
    if any(k in t for k in ["brochure", "rack card", "flyer", "postcard", "print",
                              "collateral", "business card", "mailer"]):
        return "Print - Collateral/Packaging"

    return "Misc."


def parse_todo_fields(title: str, comments: list[dict]) -> dict:
    """
    Extract PDD, HDD, EST from a todo's title and comment thread.
    Comments should be dicts with 'content' and 'creator.name' keys.
    Manager names are checked first (most authoritative source).
    """
    MANAGER_NAMES = {"richard", "richard vargas", "rich", "brittney", "brittney davis"}

    combined_title = strip_html(title)

    pdd = parse_pdd(combined_title)
    hdd = parse_hdd(combined_title)
    est = parse_est(combined_title)

    for comment in comments:
        creator = (comment.get("creator") or {}).get("name", "").lower()
        text = strip_html(comment.get("content", ""))

        # Manager comments are authoritative for EST
        if any(n in creator for n in MANAGER_NAMES):
            if est is None:
                est = parse_est(text)

        # HDD/PDD can come from any comment but prefer title
        if hdd is None:
            hdd = parse_hdd(text)
        if pdd is None:
            pdd = parse_pdd(text)

    return {
        "pdd": pdd,
        "hdd": hdd,
        "est": est,
        "revs": 0,
        "total_hours": est or 0,
    }
