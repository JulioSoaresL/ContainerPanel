# Flatpak

App ID: `io.github.JulioSoaresL.DockerPanel`. O app é o Electron de `electron/main.js`, que sobe o
`server.js` numa porta livre em 127.0.0.1. As ações de projeto usam o binário standalone do
Docker Compose embutido no pacote (`PANEL_COMPOSE_BIN=/app/bin/docker-compose`).

## Build local

```bash
flatpak install --user flathub org.flatpak.Builder
flatpak run org.flatpak.Builder --user --install --install-deps-from=flathub --force-clean \
  build-dir flatpak/io.github.JulioSoaresL.DockerPanel.yml
flatpak run io.github.JulioSoaresL.DockerPanel
```

Os dados ficam em `~/.var/app/io.github.JulioSoaresL.DockerPanel/data/docker-panel/`.

## Atualizar dependências

O build do Flatpak é offline, então toda mudança no `package-lock.json` exige regenerar as fontes:

```bash
pipx install "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node"
flatpak-node-generator npm package-lock.json -o flatpak/generated-sources.json
```

Ao atualizar o Docker Compose, troque a versão nas URLs e os `sha256` pelos arquivos
`docker-compose-linux-<arch>.sha256` publicados no release.

## Lint

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest flatpak/io.github.JulioSoaresL.DockerPanel.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo   # após build com --repo=repo
appstreamcli validate flatpak/io.github.JulioSoaresL.DockerPanel.metainfo.xml
```

## Publicar no Flathub

1. Criar a tag do release no GitHub e adicionar `docs/screenshot.png` (referenciado no metainfo).
2. No manifest, trocar a fonte `type: dir` por `type: git` com `url`, `tag` e `commit` do release.
3. Fork de [flathub/flathub](https://github.com/flathub/flathub), branch `new-pr`, com o manifest,
   `generated-sources.json`, e abrir o PR seguindo o [guia de submissão](https://docs.flathub.org/docs/for-app-authors/submission).
4. Justificar as permissões no PR:
   - `--filesystem=/run/docker.sock` / `xdg-run/docker.sock`: o app é um cliente da API do Docker.
   - `--filesystem=home`: localiza arquivos compose e o compose precisa ler os projetos nos caminhos originais.
   - `--share=network`: servidor local da interface e links para as portas dos containers.
5. O Flathub costuma barrar nomes com marcas de terceiros: talvez seja preciso trocar o nome
   exibido (ex.: "Container Panel") mantendo "Docker" só na descrição.

## Limitações

- O usuário precisa ter acesso ao socket do Docker (grupo `docker` ou Docker rootless).
- Não há CLI `docker` nem plugin `buildx` no sandbox. Subir projetos com imagens prontas funciona;
  serviços com `build:` dependem do builder que o Compose consegue usar sem o buildx (ainda não testado).
