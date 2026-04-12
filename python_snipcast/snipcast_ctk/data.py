"""Данные и фильтрация шаблонов — зеркало src/App.tsx."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, TypedDict, Union


class TemplateChild(TypedDict):
    id: str
    title: str
    preview: str
    pasteText: str


class TemplateRow(TypedDict, total=False):
    id: str
    title: str
    preview: str
    pasteText: str
    children: List[TemplateChild]


@dataclass
class FlatItem:
    id: str
    row: Union[TemplateRow, TemplateChild]
    depth: int
    pasteText: str


VAR_MAP: dict[str, str] = {
    "user": "Алексей",
    "mail": "alex@example.com",
}


def substitute_vars(text: str) -> str:
    import re

    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        return VAR_MAP.get(key, f"{{{key}}}")

    return re.sub(r"\{(\w+)\}", repl, text)


def get_paste_text(row: Union[TemplateRow, TemplateChild]) -> str:
    ch = row.get("children")
    if isinstance(ch, list) and len(ch) > 0:
        return row.get("pasteText") or ""
    if "pasteText" in row and row["pasteText"] is not None:
        return str(row["pasteText"])
    return ""


MOCK_TEMPLATES: List[TemplateRow] = [
    {
        "id": "1",
        "title": "Приветствие",
        "preview": "Добрый день, {user}! …",
        "pasteText": "Добрый день, {user}!\n\nРад снова на связи.",
    },
    {
        "id": "2",
        "title": "Подпись",
        "preview": "Варианты подписи",
        "children": [
            {
                "id": "2a",
                "title": "Краткая",
                "preview": "С уважением, {user}",
                "pasteText": "С уважением,\n{user}",
            },
            {
                "id": "2b",
                "title": "Полная",
                "preview": "{user} · {mail}",
                "pasteText": "С уважением,\n{user}\n{mail}",
            },
        ],
    },
    {
        "id": "3",
        "title": "Следующий шаг",
        "preview": "Напишите, когда будет удобно созвониться.",
        "pasteText": "Напишите, пожалуйста, когда вам будет удобно коротко созвониться.",
    },
]


def flatten_for_filter(rows: List[TemplateRow], query: str) -> List[FlatItem]:
    q = query.strip().lower()
    out: List[FlatItem] = []

    for r in rows:
        match_self = (
            not q
            or q in r["title"].lower()
            or q in r["preview"].lower()
        )
        children = r.get("children") or []
        child_matches = [
            c
            for c in children
            if not q
            or q in c["title"].lower()
            or q in c["preview"].lower()
        ]

        if match_self:
            out.append(
                FlatItem(id=r["id"], row=r, depth=0, pasteText=get_paste_text(r))
            )
            if children:
                to_add = child_matches if q else list(children)
                for c in to_add:
                    out.append(
                        FlatItem(
                            id=c["id"],
                            row=c,
                            depth=1,
                            pasteText=get_paste_text(c),
                        )
                    )
        elif child_matches:
            out.append(
                FlatItem(id=r["id"], row=r, depth=0, pasteText=get_paste_text(r))
            )
            for c in child_matches:
                out.append(
                    FlatItem(
                        id=c["id"],
                        row=c,
                        depth=1,
                        pasteText=get_paste_text(c),
                    )
                )

    return out
