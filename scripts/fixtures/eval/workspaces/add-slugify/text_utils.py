def title_case(text):
    """Capitalise the first letter of every word."""
    return " ".join(w[:1].upper() + w[1:] for w in text.split())
