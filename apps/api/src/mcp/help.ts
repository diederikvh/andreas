/**
 * `andreas_help`: wat kun je met deze MCP? Voor als iemand dat vraagt, of
 * net gekoppeld heeft. Voorbeeldzinnen in plaats van toolnamen: de
 * gebruiker praat, het model kiest de tool.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const PUBLIC = `Andreas kent het aanbod van concertzalen, clubs, bioscopen, theaters, musea en podia in Amsterdam en steden als Utrecht, Rotterdam, Den Haag, Haarlem, Eindhoven, Tilburg, Nijmegen, Groningen en Antwerpen.

Zoeken
- "Wat is er dit weekend aan techno in Amsterdam?"
- "Welke films draaien er volgende week in Utrecht?"
- "Speelt Fontaines D.C. ergens?"`;

const PERSONAL = `

Meldingen (een push om 10:00, gebundeld, alleen bij nieuw aanbod)
- "Laat me weten als er hiphop in Paradiso bijkomt."
- "Seintje bij gitaarbands met een jaren-90-randje, zoals The Afghan Whigs." Smaak in eigen woorden: een model keurt elk nieuw event en zet de reden in de push.
- "Welke meldingen heb ik?" / "Zet de hiphop-melding even uit." / "Verwijder die melding."
- "Die melding over Moss klopte niet, ik wil geen luistersessies." De keurder leert van je correcties.
- "Wat heeft de keurder deze week afgewezen?"

Artiesten
- "Volg The Afghan Whigs." Werkt ook voor wie hier nog nooit speelde.
- "Wie volg ik, en waar spelen ze?"
- "Stel artiesten voor die lijken op wie ik volg."

Je agenda en je vrienden
- "Wat doe ik deze week?" / "Botst er iets in november?"
- "Wie gaat er naar Paradiso deze maand?" / "Wat heeft Midas gered?"

Doen, zoals in de app
- "Zet een hartje op Band of Horses." / "Ik ga naar LSD and the Search for God."
- "Volg Tolhuistuin." / "Blokkeer Johan Cruijff ArenA."
- "Geen tributebands meer." / "Ik hou van shoegaze."
- "Wat heb ik allemaal ingesteld?"

Alles wat je hier doet staat meteen in de app. Kaartjes blijven op je telefoon; die ziet Andreas niet.`;

const ANON = `

Log in met je Andreas-account (telefoonnummer) om ook meldingen, artiesten volgen, je agenda, vrienden en hartjes te gebruiken.`;

export function registerHelpTool(server: McpServer, loggedIn: boolean): void {
  server.registerTool(
    'andreas_help',
    {
      title: 'Wat kan ik met Andreas?',
      description:
        'Uitleg over wat de gebruiker met Andreas kan, met voorbeeldzinnen. Gebruik dit als de gebruiker ' +
        'vraagt wat Andreas kan of hoe iets werkt, of net gekoppeld heeft. Geef de uitleg in eigen woorden ' +
        'en kort terug; noem geen toolnamen.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text' as const, text: PUBLIC + (loggedIn ? PERSONAL : ANON) }],
    })
  );
}
