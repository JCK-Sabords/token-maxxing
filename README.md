# token-maxxing

Un mod Claude Code pour jouer au token-maxxing : combien de tokens tu as brûlés, par modèle, ce mois-ci et depuis le début, et **ce que ça t'aurait coûté en BYOK** (au tarif de l'API Anthropic). Si tu renseignes le prix de ton abonnement, il te dit combien de fois tu l'as rentabilisé.

*A Claude Code mod that shows your token use per model, this month and all time, with what it would have cost on the Anthropic API (BYOK), and how many times your subscription paid for itself.*

## Ce que ça affiche

Un panneau à côté de la conversation, qui s'ouvre au démarrage d'une nouvelle session et avec `/tokens` :

- **Onglets** Ce mois / Total
- **Le montant** équivalent API en grand, avec le nombre de tokens et de réponses
- **Une jauge** « abonnement rentabilisé x3,7 », pour le mois et, dans Total, pour l'abonnement cumulé depuis le premier mois (si le prix de ton abonnement est renseigné)
- **Un histogramme mensuel** (onglet Total)
- **La répartition par modèle** : une couleur par famille (Opus, Sonnet, Haiku, Fable), coût, tokens et part du total

## Installation

Dans un terminal, à l'invite de Claude Code :

```
/plugin install token-maxxing --marketplace JCK-Sabords/token-maxxing
```

Ou depuis un shell :

```
claude plugin install token-maxxing --marketplace JCK-Sabords/token-maxxing
```

Dans l'app desktop (où `/plugin` ne marche pas) : clique sur **+** à côté du champ de saisie, puis **Plugins**, **Add marketplace** avec `JCK-Sabords/token-maxxing`, puis **Add plugin**.

Nécessite Claude Code v2.1.287 ou plus récent (v2.1.286 dans l'app desktop).

## Réglages

| Option | Par défaut | Rôle |
| --- | --- | --- |
| `planPriceUsd` | `0` | Prix de ton abonnement en $/mois. Affiche la jauge de rentabilité. `0` la masque. |
| `openOnNewSession` | `true` | Ouvre le panneau quand une nouvelle session démarre. |

Dans Claude Code : `/plugin configure token-maxxing@token-maxxing`.

## Comment c'est calculé

- **Source** : les transcripts locaux de Claude Code (`~/.claude/projects/**/*.jsonl`). Les sessions cloud et les conversations claude.ai, qui n'ont pas de transcript sur ton disque, ne sont pas comptées.
- **Chaque réponse est comptée une fois** : les transcripts écrivent plusieurs lignes par réponse, avec un nombre de tokens de sortie partiel puis final. Le mod garde le final.
- **Prix** : tarifs publics de l'API Anthropic (novembre 2026), cache compris : écriture du cache ×1,25 (5 min) ou ×2 (1 h), lecture au tarif propre à chaque modèle, mode fast ×2. Les tarifs sont dans `hooks/register.tsx` (`PRICES`).
- **Incrémental** : un cache dans `~/.claude/token-maxxing/cache.json` retient ce qui a déjà été lu. Seules les nouvelles lignes sont relues, après chaque réponse de Claude. Le cache garde aussi le cumul quand Claude Code efface d'anciens transcripts.

Le mod lit tes fichiers locaux et n'envoie rien sur le réseau.

## Licence

MIT
