import React from "react";
import type { IChatMessage } from "../../types/chat";
import ReactMarkdown from "react-markdown";

export interface IChatMessageProps {
    message: IChatMessage;
}

export const ChatMessage: React.FC<IChatMessageProps> = ({ message }) => {
    return (
        <div
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
        >
            <div
                className={`max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${message.role === "user"
                    ? "bg-maroon-500 text-white"
                    : "bg-neutral-100 text-neutral-900"
                    }`}
            >
                {message.role === "assistant" ? (
                    <div className="prose prose-sm max-w-none prose-neutral prose-p:leading-relaxed">
                        <ReactMarkdown>
                            {message.content}
                        </ReactMarkdown>
                    </div>
                ) : (
                    <div className="whitespace-pre-wrap">{message.content}</div>
                )}
                <div
                    className={`text-xs mt-2 ${message.role === "user" ? "text-maroon-200" : "text-neutral-400"
                        }`}
                >
                    {message.timestamp}
                </div>
            </div>
        </div>
    );
};
