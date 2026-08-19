import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { CommandPalette } from "@/components/CommandPalette";

export function AppLayout() {
  const [cmdOpen, setCmdOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Skip link — visually hidden until focused, lets keyboard users jump past nav */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:text-sm focus:font-medium"
      >
        Skip to main content
      </a>
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header onOpenSearch={() => setCmdOpen(true)} />
        <main
          id="main-content"
          role="main"
          className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6"
        >
          <Outlet />
        </main>
      </div>
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </div>
  );
}
