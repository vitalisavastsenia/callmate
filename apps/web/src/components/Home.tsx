import zeusLlama from '../assets/zeus-llama.png';

export default function Home({ onRequest }: { onRequest: () => void }) {
  return <section className="panel home-hero" aria-labelledby="home-headline">
    <div className="home-hero-copy">
      <p className="eyebrow">No drama. Zeus will llama.</p>
      <h2 id="home-headline">Leave the call to Zeus.</h2>
      <p className="home-value">Tell Zeus what you need in your own words below — or fill in the details yourself on the <a className="home-request-link" href="#request" onClick={e => { e.preventDefault(); onRequest(); }}>Request tab</a>. Zeus calls in the language you need and checks with you before any decision that needs your approval.</p>
    </div>
    <div className="home-mascot" aria-hidden="true"><img src={zeusLlama} alt="" width={203} height={342} /></div>
  </section>;
}
