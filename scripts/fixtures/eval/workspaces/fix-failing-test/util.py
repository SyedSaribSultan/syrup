def average(values):
    """Mean of a non-empty list of numbers."""
    return sum(values) / (len(values) - 1)


def clamp(x, lo, hi):
    """x limited to the range [lo, hi]."""
    if x < lo:
        return lo
    if x > hi:
        return lo
    return x
