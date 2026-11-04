#!/usr/bin/env python3
"""Set keys in a Java .properties file in place: props.py FILE key=value ...

Replaces the first `key=` line (commented-out lines are left alone) or
appends the key when it is missing. "-key" deletes the key.
"""
import sys


def main():
    path, pairs = sys.argv[1], sys.argv[2:]
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    for pair in pairs:
        if pair.startswith("-"):  # "-key" removes the key
            key = pair[1:]
            lines = [l for l in lines if l.split("=", 1)[0].strip() != key]
            continue
        key, value = pair.split("=", 1)
        for i, line in enumerate(lines):
            if line.split("=", 1)[0].strip() == key and not line.lstrip().startswith("#"):
                lines[i] = f"{key}={value}"
                break
        else:
            lines.append(f"{key}={value}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
