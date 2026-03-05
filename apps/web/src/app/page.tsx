import Link from "next/link";
import { DownloadCard } from "../components/Landing/DownloadCard";

export default function LandingPage() {
  return (
    <main className="min-h-screen flex flex-col">
      {/* Navigation */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-neutral-100">
        <div className="text-2xl font-bold text-maroon-500">OI</div>
        <div className="flex items-center gap-6">
          <Link href="/chat" className="text-sm font-medium text-neutral-600 hover:text-maroon-500 transition-colors">
            Open App
          </Link>
          <a
            href="#download"
            className="text-sm font-medium bg-maroon-500 text-white px-5 py-2.5 rounded-lg hover:bg-maroon-600 transition-colors"
          >
            Download
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-8 py-20 text-center">
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-neutral-900 max-w-3xl">
          Meet <span className="text-maroon-500">OI</span>, your AI assistant
          that gets things done.
        </h1>
        <p className="mt-6 text-lg text-neutral-500 max-w-xl">
          Chat naturally, plan tasks, and let OI automate them across your
          devices. When OI needs you, it asks. When it doesn&apos;t, it just works.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <a
            href="#download"
            className="bg-maroon-500 text-white px-8 py-3.5 rounded-xl text-base font-semibold hover:bg-maroon-600 transition-colors shadow-lg shadow-maroon-500/20"
          >
            Download for Desktop
          </a>
          <Link
            href="/chat"
            className="bg-white text-maroon-500 border-2 border-maroon-500 px-8 py-3.5 rounded-xl text-base font-semibold hover:bg-maroon-50 transition-colors"
          >
            Open in Browser
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="px-8 py-20 bg-maroon-950 text-white">
        <div className="max-w-5xl mx-auto grid md:grid-cols-3 gap-10">
          <div>
            <div className="text-lg font-semibold mb-2">Converse</div>
            <p className="text-neutral-300 text-sm leading-relaxed">
              Chat with text, voice, images, or camera. OI understands it all
              and responds naturally.
            </p>
          </div>
          <div>
            <div className="text-lg font-semibold mb-2">Automate</div>
            <p className="text-neutral-300 text-sm leading-relaxed">
              Describe what you need done. OI creates a plan, schedules it, and
              executes it on your behalf.
            </p>
          </div>
          <div>
            <div className="text-lg font-semibold mb-2">Mesh</div>
            <p className="text-neutral-300 text-sm leading-relaxed">
              Connect all your devices. Share tasks with family. Anyone in your
              mesh can help when OI is stuck.
            </p>
          </div>
        </div>
      </section>

      {/* Download */}
      <section id="download" className="px-8 py-20">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-neutral-900 mb-8">Download OI</h2>
          <div className="grid sm:grid-cols-3 gap-6">
            <DownloadCard platform="macOS" description="Apple Silicon & Intel" />
            <DownloadCard platform="Windows" description="Windows 10+" />
            <DownloadCard platform="Linux" description="AppImage" />
          </div>
          <div className="mt-8 flex justify-center gap-4">
            <a href="#" className="text-sm text-maroon-500 hover:underline">
              App Store
            </a>
            <a href="#" className="text-sm text-maroon-500 hover:underline">
              Google Play
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-8 py-6 border-t border-neutral-100 text-center text-sm text-neutral-400">
        OI &copy; {new Date().getFullYear()}
      </footer>
    </main>
  );
}
