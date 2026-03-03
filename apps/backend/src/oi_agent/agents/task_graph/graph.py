from __future__ import annotations

from langgraph.graph import END, StateGraph

from oi_agent.agents.task_graph.checkpointer import FirestoreCheckpointer
from oi_agent.agents.task_graph.nodes import companion, consult, curate, schedule
from oi_agent.agents.task_graph.state import TaskState


def build_task_graph() -> StateGraph:
    """Build the Task Lifecycle state machine.

    Nodes:
        curate    -- decompose user request into a plan
        schedule  -- wait for trigger time (or execute immediately)
        companion -- execute each step of the plan
        consult   -- pause for human action when blocked

    Edges:
        curate -> schedule -> companion -> (loop | consult | END)
        consult -> (companion | curate | END)
    """
    graph = StateGraph(TaskState)

    graph.add_node("curate", curate.run)
    graph.add_node("schedule", schedule.run)
    graph.add_node("companion", companion.run)
    graph.add_node("consult", consult.run)

    graph.set_entry_point("curate")

    graph.add_edge("curate", "schedule")

    graph.add_conditional_edges("schedule", schedule.route, {
        "execute": "companion",
        "wait": END,
    })

    graph.add_conditional_edges("companion", companion.route, {
        "next_step": "companion",
        "blocked": "consult",
        "done": END,
        "failed": END,
    })

    graph.add_conditional_edges("consult", consult.route, {
        "resume": "companion",
        "re_plan": "curate",
        "cancel": END,
    })

    return graph


def compile_task_graph() -> StateGraph:
    """Compile the task graph with Firestore checkpointing."""
    graph = build_task_graph()
    return graph.compile(checkpointer=FirestoreCheckpointer())


task_graph = compile_task_graph()
