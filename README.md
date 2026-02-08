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
<type> <name[dims]> [(<symbol>)] <description> [~ <distribution>]
```

- `(<symbol>)` is optional; default is `<name>_{<dim_labels>}` when dimensions are present (using each `dim` label override when provided), otherwise `<name>`
- `type` is one of: `latent`, `observed`, `fixed`, `deterministic`
- `~ <distribution>` is optional
- If you provide a symbol that exactly matches the legacy auto pattern (e.g. `x_i` / `x_{i}` for `x[i]`), it is treated like an auto symbol and will still follow dim label overrides.

Example:

```text
latent alpha (\alpha) concentration ~ N(0,1)
latent theta[k] (\theta_k) weights ~ Dirichlet(\alpha)
latent z[i] (z_i) assignments ~ Categorical(\theta)
observed x[i] (x_i) "observed values"
fixed mu (\mu) center
deterministic y[i] (y_i) transformed
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
