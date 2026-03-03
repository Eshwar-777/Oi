from __future__ import annotations

from typing import Any


def can_user_act_on_task(user_id: str, task: dict[str, Any]) -> bool:
    """Check if a user is authorized to act on a task.

    A user can act on a task if they are the task creator or a member
    of the task's mesh group.
    """
    if task.get("created_by", {}).get("user_id") == user_id:
        return True

    mesh_members = task.get("mesh_members", [])
    return any(member.get("user_id") == user_id for member in mesh_members)


def can_user_manage_mesh(user_id: str, group: dict[str, Any]) -> bool:
    """Check if a user is the owner of a mesh group."""
    return group.get("owner_user_id") == user_id
