# Roadmap to production

- **Real hospital integration (HL7 FHIR):** hospitals expose beds, queue and vitals
  through FHIR APIs. Hard part is not the API - it is hospital IT buy-in; start with
  one partner clinic.
- **Live lab price compare:** tie up with lab chains' booking APIs or aggregators
  (1mg, Healthians). Prices change by city and offer; needs a commercial partnership,
  not just scraping.
- **Push notifications:** move reminders and queue alerts to a PWA with web push so
  they fire when the tab is closed.
- **Doctor-side console:** doctors confirm reports the AI read, building trust and a
  correction loop.
- **Offline-first PWA:** families in low-connectivity areas keep their timeline and
  emergency card without a network.
- **ABHA/ABDM linking:** India's health-ID stack could carry records across providers
  with consent - the right long-term backbone.
- **Multilingual:** Hindi today; add Marathi, Tamil, Bengali and Telugu for the
  summaries next.
