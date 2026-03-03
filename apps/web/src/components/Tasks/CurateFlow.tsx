import React, { useState } from "react";
import { Card, CardContent, CardHeader } from "../UI/Card";
import { useCreateTask } from "../../hooks/useManageTasks";
import ReactMarkdown from "react-markdown";

type MessageNode = {
    role: "user" | "agent";
    content: string;
};

export const CurateFlow: React.FC = () => {
    const [taskName, setTaskName] = useState("");
    const [description, setDescription] = useState("");
    // Conversation State
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [history, setHistory] = useState<MessageNode[]>([]);
    const [draftReply, setDraftReply] = useState("");
    const [isTaskCreated, setIsTaskCreated] = useState(false);

    const { mutate: sendChat, isPending } = useCreateTask();

    const handleGenerate = () => {
        if (!description.trim()) return;

        // In our backend architecture, sending a chat message with intent triggers the task graph
        const prompt = taskName.trim()
            ? `Create a task named "${taskName}": ${description}`
            : description;

        setHistory([{ role: "user", content: prompt }]);
        setIsTaskCreated(false);

        sendChat({ message: prompt }, {
            onSuccess: (data) => {
                setSessionId(data.session_id);
                if (data.task_created) {
                    setIsTaskCreated(true);
                } else {
                    setHistory((prev) => [...prev, { role: "agent", content: data.response }]);
                }
            }
        });
    };

    const handleReply = () => {
        if (!draftReply.trim() || !sessionId) return;

        setHistory((prev) => [...prev, { role: "user", content: draftReply }]);
        const currentReply = draftReply;
        setDraftReply("");

        sendChat({ message: currentReply, sessionId }, {
            onSuccess: (data) => {
                if (data.task_created) {
                    setIsTaskCreated(true);
                } else {
                    setHistory((prev) => [...prev, { role: "agent", content: data.response }]);
                }
            }
        });
    };

    // Determine which UI phase we are in
    const isConversing = history.length > 0;

    return (
        <div className="max-w-3xl mx-auto space-y-6 pb-20">
            <div className="mb-8">
                <h2 className="text-xl font-bold text-neutral-900 mb-2">Curate a New Task</h2>
                <p className="text-sm text-neutral-500">
                    Describe what you want to automate, and OI will generate an execution plan.
                </p>
            </div>

            <Card>
                <CardContent className="space-y-5">
                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-neutral-700">Task Name</label>
                        <input
                            type="text"
                            value={taskName}
                            onChange={(e) => setTaskName(e.target.value)}
                            placeholder="e.g. AI News Digest"
                            disabled={isConversing}
                            className="w-full px-4 py-2.5 rounded-lg border border-neutral-300 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-maroon-500 disabled:opacity-50 disabled:bg-neutral-50"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-neutral-700">What do you want to automate?</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="e.g. Send me the latest AI news every 4 hours..."
                            rows={3}
                            disabled={isConversing}
                            className="w-full px-4 py-2.5 rounded-lg border border-neutral-300 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-maroon-500 resize-none disabled:opacity-50 disabled:bg-neutral-50"
                        />
                    </div>

                    {!isConversing && (
                        <div className="flex justify-end">
                            <button
                                onClick={handleGenerate}
                                disabled={!description.trim() || isPending}
                                className="bg-maroon-600 hover:bg-maroon-700 disabled:bg-maroon-300 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm"
                            >
                                {isPending ? "Starting..." : "Generate Plan"}
                            </button>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Plan Preview / Chat Interface UI */}
            {!isTaskCreated && isConversing && (
                <Card className="border-maroon-200 border-2 bg-maroon-50/20 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <CardHeader className="bg-maroon-50/50 border-b border-maroon-100">
                        <div className="font-semibold text-sm text-maroon-900 flex items-center gap-2">
                            <span>💬</span> Agent Clarifications
                        </div>
                    </CardHeader>
                    <CardContent className="p-0">
                        <div className="flex flex-col space-y-4 p-6 max-h-96 overflow-y-auto">
                            {history.slice(1).map((msg, idx) => (
                                <div
                                    key={idx}
                                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div
                                        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${msg.role === 'user'
                                            ? 'bg-neutral-800 text-white rounded-br-sm'
                                            : 'bg-white border border-neutral-200 text-neutral-800 rounded-bl-sm shadow-sm'
                                            }`}
                                    >
                                        {msg.role === 'agent' ? (
                                            <div className="prose prose-sm max-w-none prose-neutral prose-p:leading-relaxed prose-pre:bg-neutral-100 prose-pre:text-neutral-900">
                                                <ReactMarkdown>
                                                    {msg.content}
                                                </ReactMarkdown>
                                            </div>
                                        ) : (
                                            <span className="whitespace-pre-wrap">{msg.content}</span>
                                        )}
                                    </div>
                                </div>
                            ))}

                            {isPending && (
                                <div className="flex justify-start">
                                    <div className="bg-white border border-neutral-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm flex items-center space-x-2 w-16">
                                        <div className="w-2 h-2 bg-maroon-300 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                        <div className="w-2 h-2 bg-maroon-300 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                        <div className="w-2 h-2 bg-maroon-300 rounded-full animate-bounce"></div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="p-4 bg-white border-t border-maroon-100 rounded-b-xl flex gap-3">
                            <input
                                type="text"
                                value={draftReply}
                                onChange={(e) => setDraftReply(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleReply()}
                                placeholder="Type your reply here..."
                                disabled={isPending}
                                className="flex-1 px-4 py-2 bg-neutral-100 border border-transparent focus:bg-white rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-maroon-500 transition-colors"
                            />
                            <button
                                onClick={handleReply}
                                disabled={!draftReply.trim() || isPending}
                                className="bg-maroon-600 hover:bg-maroon-700 disabled:opacity-50 text-white rounded-full p-2 w-10 h-10 flex items-center justify-center transition-colors"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 ml-0.5">
                                    <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
                                </svg>
                            </button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {isTaskCreated && (
                <Card className="border-green-200 border-2 bg-green-50/50 animate-in fade-in zoom-in-95 duration-500">
                    <CardContent>
                        <div className="text-sm text-green-700 flex flex-col items-center py-8">
                            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center text-3xl mb-4 shadow-sm">
                                ✅
                            </div>
                            <span className="font-bold text-lg text-center text-green-900 mb-1">Task successfully created!</span>
                            <span className="text-green-800/80 text-center max-w-sm">
                                The agent has gathered enough context and compiled your execution plan. Check the <b>Companion</b> tab to view it.
                            </span>
                            <button
                                onClick={() => {
                                    setTaskName("");
                                    setDescription("");
                                    setHistory([]);
                                    setSessionId(null);
                                    setIsTaskCreated(false);
                                }}
                                className="mt-6 border border-green-300 bg-white text-green-800 hover:bg-green-100 px-5 py-2 rounded-lg text-sm font-medium transition-colors"
                            >
                                Create another task
                            </button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {!isConversing && !isTaskCreated && (
                <Card className="border-dashed border-2 bg-neutral-50/50">
                    <CardHeader>
                        <div className="font-semibold text-sm text-neutral-500 flex items-center gap-2">
                            <span>📋</span> Agent Clarifications
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="text-sm text-neutral-400 italic text-center py-8">
                            If the agent needs more information to build your task,<br /> the conversation will appear here.
                        </div>
                    </CardContent>
                </Card>
            )}

        </div>
    );
};
