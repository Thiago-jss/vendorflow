import { applicationName } from "@/lib/application";

export default function HomePage() {
  return (
    <main>
      <p className="eyebrow">Platform bootstrap</p>
      <h1>{applicationName}</h1>
      <p>The application shell is running. Product workflows will be introduced in subsequent issues.</p>
    </main>
  );
}
