import type { AXNode, RefEntry } from "./types";

// Roles that are interactive or meaningful enough to expose to the agent.
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox",
  "radio", "switch", "slider", "spinbutton", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "treeitem",
  "listbox", "menu", "tree", "grid", "row", "cell",
  "heading", "img", "dialog", "alertdialog", "navigation",
  "search", "form", "main", "complementary", "banner",
  "contentinfo", "region", "alert",
]);

export function buildRoleSnapshot(nodes: AXNode[]): { lines: string[]; refMap: Record<string, RefEntry> } {
  const refMap: Record<string, RefEntry> = {};
  const lines: string[] = [];
  let refIdx = 0;
  const duplicateCounter = new Map<string, number>();
  const emittedNodeIds = new Set<string>();
  const MAX_REFS = 250;

  const nodeMap = new Map<string, AXNode>();
  for (const n of nodes) nodeMap.set(n.nodeId, n);

  function emitNode(node: AXNode, depth: number): boolean {
    if (Object.keys(refMap).length >= MAX_REFS) return false;
    const roleRaw = node.role?.value ?? "";
    const role = roleRaw.toLowerCase();
    const name = node.name?.value ?? "";
    const desc = node.description?.value ?? "";

    // Skip generic/structural roles unless they have a name.
    const isGeneric = role === "none" || role === "generic" || role === "genericcontainer" || role === "" || role === "group";
    const isInteresting = INTERACTIVE_ROLES.has(role) || (!isGeneric && name !== "");
    if (!isInteresting) return false;

    const ref = `e${refIdx}`;
    refIdx++;

    const key = `${role}::${(name || "").toLowerCase()}`;
    const nth = duplicateCounter.get(key) ?? 0;
    duplicateCounter.set(key, nth + 1);

    const entry: RefEntry = { role, name, nth };
    if (desc) entry.description = desc;
    if (typeof node.backendDOMNodeId === "number") {
      entry.backendDOMNodeId = node.backendDOMNodeId;
    }

    const levelProp = node.properties?.find((p) => p.name === "level");
    if (levelProp) entry.level = levelProp.value.value as number;

    refMap[ref] = entry;

    const indent = "  ".repeat(Math.min(depth, 6));
    let line = `${indent}[${ref}] ${roleRaw}`;
    if (name) line += ` "${name.substring(0, 80)}"`;
    if (entry.level) line += ` [level=${entry.level}]`;
    if (typeof entry.nth === "number" && entry.nth > 0) line += ` [nth=${entry.nth}]`;
    if (desc) line += ` (${desc.substring(0, 60)})`;
    lines.push(line);
    return true;
  }

  function walkNode(nodeId: string, depth: number): void {
    const node = nodeMap.get(nodeId);
    if (!node || node.ignored) return;
    if (emittedNodeIds.has(nodeId)) return;
    emittedNodeIds.add(nodeId);

    const emitted = emitNode(node, depth);

    if (node.childIds) {
      for (const childId of node.childIds) {
        walkNode(childId, emitted ? depth + 1 : depth);
      }
    }
  }

  if (nodes.length > 0) {
    walkNode(nodes[0].nodeId, 0);
  }

  // Fallback for sparse/disconnected AX trees (common on heavy SPAs like Gmail).
  if (Object.keys(refMap).length <= 1) {
    for (const node of nodes) {
      if (Object.keys(refMap).length >= MAX_REFS) break;
      if (node.ignored || emittedNodeIds.has(node.nodeId)) continue;
      emitNode(node, 0);
    }
  }

  return { lines, refMap };
}

