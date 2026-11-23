import React from 'react';
import CreatePanel from '../components/CreatePanel';

export default function Landing({ notify, health, initialMode = 'clips' }) {
  return (
    <main id="top">
      <section className="hero studio-hero">
        <CreatePanel notify={notify} health={health} initialMode={initialMode} />
      </section>
    </main>
  );
}
