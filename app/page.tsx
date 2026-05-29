import SpendProfileForm from "@/components/SpendProfileForm";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Spend Profile Agent</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Paste an annual-report URL or upload a PDF. Get a procurement spend profile with verified
          citations in about 2 minutes.
        </p>
      </header>
      <SpendProfileForm />
    </main>
  );
}
