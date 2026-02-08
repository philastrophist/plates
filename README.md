# DAFT-style Bayesian Plate DSL (Interactive)

Interactive in-browser Bayesian plate diagramming with a DSL, ELK auto-layout, and DAFT-inspired visuals.

## Run

```bash
python3 -m http.server 4173
# open http://localhost:4173
```

## DSL

### Dimensions

```text
dim <symbol>[(<label_override_in_mathjax>)] [description]
```

Example:

```text
dim k components
dim i(i_{1:N}) observations
```

### Nodes

```text
node <name[dims]> [(<symbol>)] <description> <type> ~ <distribution>
```

- `(<symbol>)` is optional; default is `<name>_{<dims>}` when dimensions are present, otherwise `<name>`
- `type` is one of: `latent`, `observed`, `fixed`, `deterministic`
- `~ <distribution>` is optional (useful for deterministic/fixed nodes)

Example:

```text
node alpha (\alpha) concentration latent ~ N(0,1)
node theta[k] (\theta_k) weights latent ~ Dirichlet(\alpha)
node z[i] (z_i) assignments latent ~ Categorical(\theta)
node x[i] (x_i) "observed values" observed
node mu (\mu) center fixed
node y[i] (y_i) transformed deterministic
```

### Edges

```text
alpha -> theta[k] -> z[i] -> x[i]
mu -> y[i] <- z[i]
```

## Render mapping

- `latent`: white circle
- `observed`: shaded circle
- `fixed`: solid dot
- `deterministic`: box

Plates are inferred from node dimensions (`name[dim]`) and labeled from corresponding `dim` declarations.


`label_override` is optional and used for plate labels only; it is always rendered as MathJax. If omitted, the dimension symbol is used as the label (also rendered as MathJax). Description, when provided, is rendered after the symbol/label in the plate label.
