"""Salesforce language codes, display names and grammar rules, shared by every script.

LANGUAGES holds every language code Salesforce offers (221), with the English name
Salesforce shows for it. It was read from the User object's LanguageLocaleKey picklist,
which lists fully supported, end-user and platform-only languages alike.
The scripts refuse a code that is not listed (require_known), because a wrong code fails
quietly further down. Declare a newer Salesforce language in settings.json
("extra_languages": {"xx": "Name"}).

The display name is what the workbook uses in its column headers ("German Translation"),
and every reader maps a header back to its code through this module, so names must stay
unique.

GRAMMAR. Object names and renamed standard fields need extra attributes in some languages
(gender, starts-with, article, possessive, case forms). The rules below are a general
reference; confirm them for your org with a sandbox dry run. A language with no entry has UNKNOWN grammar: it gets no grammar
columns, and its object-name and renamed-field rows are not loaded (a missing gender
fails the whole object file). Field labels, picklist values, messages and the rest of the
main workbook tab need no grammar in any language. To add a language, copy the closest
entry (None means "needs none"), then confirm it with a sandbox dry run.
"""
from __future__ import annotations

LANGUAGES: dict[str, str] = {
    'en_US': 'English',
    'de': 'German',
    'es': 'Spanish',
    'fr': 'French',
    'it': 'Italian',
    'ja': 'Japanese',
    'sv': 'Swedish',
    'ko': 'Korean',
    'zh_TW': 'Chinese (Traditional)',
    'zh_CN': 'Chinese (Simplified)',
    'pt_BR': 'Portuguese (Brazil)',
    'nl_NL': 'Dutch',
    'da': 'Danish',
    'th': 'Thai',
    'fi': 'Finnish',
    'ru': 'Russian',
    'es_MX': 'Spanish (Mexico)',
    'no': 'Norwegian',
    'hu': 'Hungarian',
    'pl': 'Polish',
    'cs': 'Czech',
    'tr': 'Turkish',
    'in': 'Indonesian',
    'ro': 'Romanian',
    'vi': 'Vietnamese',
    'uk': 'Ukrainian',
    'iw': 'Hebrew',
    'el': 'Greek',
    'bg': 'Bulgarian',
    'en_GB': 'English (UK)',
    'ar': 'Arabic',
    'sk': 'Slovak',
    'pt_PT': 'Portuguese (European)',
    'hr': 'Croatian',
    'sl': 'Slovene',
    'fr_CA': 'French (Canadian)',
    'ka': 'Georgian',
    'sr': 'Serbian (Cyrillic)',
    'sh': 'Serbian (Latin)',
    'en_AU': 'English (Australian)',
    'en_MY': 'English (Malaysian)',
    'en_IN': 'English (Indian)',
    'en_PH': 'English (Phillipines)',
    'en_CA': 'English (Canadian)',
    'ro_MD': 'Romanian (Moldova)',
    'bs': 'Bosnian',
    'mk': 'Macedonian',
    'lv': 'Latvian',
    'lt': 'Lithuanian',
    'et': 'Estonian',
    'sq': 'Albanian',
    'sh_ME': 'Montenegrin',
    'mt': 'Maltese',
    'ga': 'Irish',
    'eu': 'Basque',
    'cy': 'Welsh',
    'is': 'Icelandic',
    'cac': 'Chuj',
    'quc': 'Kiche',
    'cak': 'Kaqchikel',
    'ms': 'Malay',
    'tl': 'Tagalog',
    'lb': 'Luxembourgish',
    'rm': 'Romansh',
    'hy': 'Armenian',
    'hi': 'Hindi',
    'ur': 'Urdu',
    'bn': 'Bengali',
    'de_AT': 'German (Austria)',
    'de_CH': 'German (Switzerland)',
    'ta': 'Tamil',
    'ar_DZ': 'Arabic (Algeria)',
    'ar_BH': 'Arabic (Bahrain)',
    'ar_EG': 'Arabic (Egypt)',
    'ar_IQ': 'Arabic (Iraq)',
    'ar_JO': 'Arabic (Jordan)',
    'ar_KW': 'Arabic (Kuwait)',
    'ar_LB': 'Arabic (Lebanon)',
    'ar_LY': 'Arabic (Libya)',
    'ar_MA': 'Arabic (Morocco)',
    'ar_OM': 'Arabic (Oman)',
    'ar_QA': 'Arabic (Qatar)',
    'ar_SA': 'Arabic (Saudi Arabia)',
    'ar_SD': 'Arabic (Sudan)',
    'ar_SY': 'Arabic (Syria)',
    'ar_TN': 'Arabic (Tunisia)',
    'ar_AE': 'Arabic (United Arab Emirates)',
    'ar_YE': 'Arabic (Yemen)',
    'zh_SG': 'Chinese (Singapore)',
    'zh_HK': 'Chinese (Hong Kong)',
    'en_HK': 'English (Hong Kong)',
    'en_IE': 'English (Ireland)',
    'en_SG': 'English (Singapore)',
    'en_ZA': 'English (South Africa)',
    'fr_BE': 'French (Belgium)',
    'fr_LU': 'French (Luxembourg)',
    'fr_CH': 'French (Switzerland)',
    'de_BE': 'German (Belgium)',
    'de_LU': 'German (Luxembourg)',
    'it_CH': 'Italian (Switzerland)',
    'nl_BE': 'Dutch (Belgium)',
    'es_AR': 'Spanish (Argentina)',
    'es_BO': 'Spanish (Bolivia)',
    'es_CL': 'Spanish (Chile)',
    'es_CO': 'Spanish (Colombia)',
    'es_CR': 'Spanish (Costa Rica)',
    'es_DO': 'Spanish (Dominican Republic)',
    'es_EC': 'Spanish (Ecuador)',
    'es_SV': 'Spanish (El Salvador)',
    'es_GT': 'Spanish (Guatemala)',
    'es_HN': 'Spanish (Honduras)',
    'es_NI': 'Spanish (Nicaragua)',
    'es_PA': 'Spanish (Panama)',
    'es_PY': 'Spanish (Paraguay)',
    'es_PE': 'Spanish (Peru)',
    'es_PR': 'Spanish (Puerto Rico)',
    'es_US': 'Spanish (United States)',
    'es_UY': 'Spanish (Uruguay)',
    'es_VE': 'Spanish (Venezuela)',
    'ca': 'Catalan',
    'af': 'Afrikaans',
    'sw': 'Swahili',
    'zu': 'Zulu',
    'xh': 'Xhosa',
    'te': 'Telugu',
    'ml': 'Malayalam',
    'kn': 'Kannada',
    'mr': 'Marathi',
    'gu': 'Gujarati',
    'pa': 'Punjabi',
    'en_NZ': 'English (New Zealand)',
    'mi': 'Te reo',
    'my': 'Burmese',
    'fa': 'Farsi',
    'km': 'Khmer',
    'am': 'Amharic',
    'kk': 'Kazakh',
    'ht': 'Haitian Creole',
    'sm': 'Samoan',
    'haw': 'Hawaiian',
    'zh_MY': 'Chinese (Malaysia)',
    'ru_LT': 'Russian (Lithuania)',
    'ru_PL': 'Russian (Poland)',
    'ru_AM': 'Russian (Armenia)',
    'ru_KZ': 'Russian (Kazakhstan)',
    'ru_KG': 'Russian (Kyrgyzstan)',
    'ru_BY': 'Russian (Belarus)',
    'ru_MD': 'Russian (Moldova)',
    'ru_UA': 'Russian (Ukraine)',
    'en_AE': 'English (United Arab Emirates)',
    'en_BE': 'English (Belgium)',
    'en_CY': 'English (Cyprus)',
    'en_DE': 'English (Germany)',
    'en_IL': 'English (Israel)',
    'en_IT': 'English (Italy)',
    'en_NL': 'English (Netherlands)',
    'en_MT': 'English (Malta)',
    'en_ES': 'English (Spain)',
    'en_PL': 'English (Poland)',
    'en_DK': 'English (Denmark)',
    'en_SE': 'English (Sweden)',
    'en_NO': 'English (Norway)',
    'en_FR': 'English (France)',
    'en_HU': 'English (Hungary)',
    'en_CZ': 'English (Czechia)',
    'en_SK': 'English (Slovakia)',
    'en_RO': 'English (Romania)',
    'en_CH': 'English (Switzerland)',
    'en_AL': 'English (Albania)',
    'en_AD': 'English (Andorra)',
    'en_AG': 'English (Antigua and Barbuda)',
    'en_AT': 'English (Austria)',
    'en_BS': 'English (Bahamas)',
    'en_BB': 'English (Barbados)',
    'en_BZ': 'English (Belize)',
    'en_BA': 'English (Bosnia and Herzegovina)',
    'en_BG': 'English (Bulgaria)',
    'en_HR': 'English (Croatia)',
    'en_DM': 'English (Dominica)',
    'en_EE': 'English (Estonia)',
    'en_FI': 'English (Finland)',
    'en_GI': 'English (Gibraltar)',
    'en_GR': 'English (Greece)',
    'en_GD': 'English (Grenada)',
    'en_GY': 'English (Guyana)',
    'en_IS': 'English (Iceland)',
    'en_JM': 'English (Jamaica)',
    'en_JP': 'English (Japan)',
    'en_LV': 'English (Latvia)',
    'en_LI': 'English (Liechtenstein)',
    'en_LT': 'English (Lithuania)',
    'en_LU': 'English (Luxembourg)',
    'en_MC': 'English (Monaco)',
    'en_ME': 'English (Montenegro)',
    'en_MK': 'English (North Macedonia)',
    'en_PT': 'English (Portugal)',
    'en_RS': 'English (Serbia)',
    'en_SI': 'English (Slovenia)',
    'en_KR': 'English (South Korea)',
    'en_KN': 'English (St. Kitts and Nevis)',
    'en_LC': 'English (St. Lucia)',
    'en_VC': 'English (St. Vincent and the Grenadines)',
    'en_TW': 'English (Taiwan)',
    'en_TH': 'English (Thailand)',
    'en_TT': 'English (Trinidad and Tobago)',
    'en_TR': 'English (Turkey)',
    'nl_SR': 'Dutch (Suriname)',
    'fr_HT': 'French (Haiti)',
    'de_LI': 'German (Liechtenstein)',
    'es_AD': 'Spanish (Andorra)',
    'sv_FI': 'Swedish (Finland)',
    'pt_AO': 'Portuguese (Angola)',
    'en_MU': 'English (Mauritius)',
    'en_SA': 'English (Saudi Arabia)',
    'en_MX': 'English (Mexico)',
    'en_BR': 'English (Brazil)',
    'el_CY': 'Greek (Cyprus)',
    'fr_MA': 'French (Morocco)',
    'kl': 'Greenlandic',
    'ji': 'Yiddish',
    'hmn': 'Hmong',
}

# Common header spellings that differ from Salesforce's display name, mapped to the code.
ALIASES: dict[str, str] = {
    "slovenian": "sl",
}

# Languages Salesforce adds later can be declared in settings.json ("extra_languages").
try:
    from toolkit_settings import SETTINGS as _SETTINGS
    LANGUAGES.update(_SETTINGS.get("extra_languages") or {})
except ImportError:  # imported on its own, outside the scripts folder
    pass

# Common codes that are NOT Salesforce's, with the code Salesforce uses instead.
HINTS: dict[str, str] = {
    "nl": "nl_NL", "he": "iw", "id": "in", "yi": "ji", "nb": "no", "nn": "no",
    "en": "en_US", "pt": "pt_PT or pt_BR", "zh": "zh_CN or zh_TW", "sr_Latn": "sh",
    "de_DE": "de", "fr_FR": "fr", "it_IT": "it", "es_ES": "es", "ja_JP": "ja",
    "ko_KR": "ko", "ru_RU": "ru", "pl_PL": "pl", "sv_SE": "sv", "da_DK": "da",
    "fi_FI": "fi", "cs_CZ": "cs", "hu_HU": "hu", "tr_TR": "tr", "en_UK": "en_GB",
}

_BY_NAME = {n.lower(): c for c, n in LANGUAGES.items()}
_BY_CODE = {c.lower(): c for c in LANGUAGES}


def unknown_codes(codes) -> list[str]:
    """Codes Salesforce does not offer, each with a hint where one is known."""
    out = []
    for c in codes:
        if c not in LANGUAGES:
            hint = HINTS.get(c)
            out.append(f"{c} (use {hint})" if hint else c)
    return out


def require_known(codes, where: str) -> None:
    """Stop with a clear message if any code is not a Salesforce language code. A wrong
    code does not fail loudly later: Salesforce rejects it at deploy, or a workbook column
    for it maps to nothing and its text lands in another language's files."""
    bad = unknown_codes(codes)
    if bad:
        import sys
        sys.exit(f"error ({where}): not Salesforce language code(s): {', '.join(bad)}. "
                 "The full list is in sf_languages.py. A language Salesforce added after this "
                 "toolkit was built can be declared in settings.json under \"extra_languages\".")


def name(code: str) -> str:
    """Display name used in workbook headers. Unknown codes display as themselves."""
    return LANGUAGES.get(code, code)


def code_for(header_name: str) -> str | None:
    """Language code for a header's language part: a display name, an alias or a bare code."""
    key = (header_name or "").strip().lower()
    if not key:
        return None
    return _BY_NAME.get(key) or ALIASES.get(key) or _BY_CODE.get(key)


def ordered(codes) -> list[str]:
    """English first, then alphabetical by display name: the workbook's column order."""
    codes = set(codes)
    rest = sorted((c for c in codes if c != "en_US"), key=lambda c: name(c).lower())
    return (["en_US"] if "en_US" in codes else []) + rest


# ── Grammar ──────────────────────────────────────────────────────────────────
# Grammar selectors for object names and renamed standard fields, per language.
# None = needs no grammar property; absent = unknown (see grammar_known).
# This is a general reference of Salesforce grammar behaviour for common languages, not a
# list of languages any org must use. Confirm an entry with a one-value-per-component dry
# run before relying on it, and add other languages the same way.
LANGUAGE_GRAMMAR: dict[str, dict | None] = {
    "en_US": {"type": "startsWith", "label": "Starts with vowel or consonant sound",
              "values": ["Vowel sound", "Consonant sound"]},
    "cs":    {"type": "gender",     "label": "Gender",                  "values": ["Neuter", "Feminine", "Masculine", "AnimateMasculine"]},
    # Danish/Swedish common gender (utrum) maps to the Feminine enum member: Salesforce
    # has no "Common" value and rejects it.
    "da":    {"type": "gender",     "label": "Gender",                  "values": ["Feminine", "Neuter"]},
    # Dutch rejects Masculine ("Invalid gender 'Masculine' for language DUTCH"); its common
    # gender maps to Feminine. Salesforce validates gender PER LANGUAGE.
    "nl_NL": {"type": "gender",     "label": "Gender",                  "values": ["Feminine", "Neuter"]},
    "et":    None,
    "fi":    None,
    "fr":    {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"],        "starts_with": True},
    "fr_BE": {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"],        "starts_with": True},
    "fr_CA": {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"],        "starts_with": True},
    "de":    {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine", "Neuter"]},
    "hu":    {"type": "startsWith", "label": "Starts with vowel or consonant sound",
              "values": ["Vowel sound", "Consonant sound"]},
    "it":    {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"],        "starts_with": True},
    "lv":    {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"]},
    "lt":    {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"]},
    "pl":    {"type": "gender",     "label": "Gender",                  "values": ["Neuter", "Feminine", "Masculine", "AnimateMasculine"]},
    "pt_PT": {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"]},
    "pt_BR": {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"]},
    "es":    {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"]},
    "es_MX": {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine"]},
    # Romanian requires BOTH gender and article on these rows.
    "ro":    {"type": "gender",     "label": "Gender",                  "values": ["Masculine", "Feminine", "Neuter"]},
    "ru":    {"type": "gender",     "label": "Gender",                  "values": ["Neuter", "Feminine", "Masculine", "AnimateMasculine"]},
    "sk":    {"type": "gender",     "label": "Gender",                  "values": ["Neuter", "Feminine", "Masculine", "AnimateMasculine"]},
    "sv":    {"type": "gender",     "label": "Gender",                  "values": ["Feminine", "Neuter"]},
}

# Case forms for object names. Languages not listed use Singular/Plural only.
LANGUAGE_CASE_FORMS: dict[str, list[str]] = {
    "de": ["Nominative", "Accusative", "Genitive", "Dative"],
    "ru": ["Nominative", "Accusative", "Genitive", "Dative", "Instrumental", "Prepositional"],
    "cs": ["Nominative", "Genitive", "Dative", "Accusative", "Instrumental", "Locative"],
    "sk": ["Nominative", "Genitive", "Dative", "Accusative", "Instrumental", "Locative"],
    "pl": ["Nominative", "Genitive", "Dative", "Accusative", "Instrumental", "Locative"],
    "lt": ["Nominative", "Genitive", "Dative", "Accusative", "Instrumental", "Locative"],
    "lv": ["Nominative", "Genitive", "Dative", "Accusative", "Instrumental", "Locative"],
    "fi": ["Nominative", "Genitive", "Partitive", "Accusative", "Allative", "Adessive",
           "Ablative", "Inessive", "Elative", "Illative", "Translative"],
    "et": ["Nominative", "Genitive", "Partitive", "Illative", "Inessive", "Elative",
           "Allative", "Adessive", "Ablative", "Translative", "Essive", "Abessive",
           "Comitative", "Terminative"],
    "ro": ["Nominative", "Dative"],
}

# Article forms for object names, applied per case.
LANGUAGE_ARTICLE_FORMS: dict[str, list[str]] = {
    "da": ["None", "Definite", "Indefinite"],
    "no": ["None", "Definite", "Indefinite"],
    "sv": ["None", "Definite", "Indefinite"],
    "ro": ["None", "Definite"],
}

# Possessive suffixes (None/First/Second) instead of articles. Salesforce rejects these
# languages' caseValues without a <possessive>.
LANGUAGE_POSSESSIVE_FORMS: dict[str, list[str]] = {
    "fi": ["None", "First", "Second"],
    "hu": ["None", "First", "Second"],
}

# On a renamed standard FIELD only the base form (None) of the article or possessive is
# accepted, and these languages require it. It is written automatically.
FIELD_POSSESSIVE_LANGS = frozenset({"fi", "hu"})
FIELD_ARTICLE_LANGS = frozenset({"da", "sv", "ro"})


def grammar_known(lang: str) -> bool:
    """True when this language's grammar rules are known: it has an entry in
    LANGUAGE_GRAMMAR, even None ("needs none"). False means unknown, not "none"."""
    return lang in LANGUAGE_GRAMMAR
