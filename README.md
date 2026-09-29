# docker-panel

Painel web local para gerenciar **todos** os containers Docker da máquina — de qualquer
`docker compose`, de qualquer pasta, ou containers avulsos (`docker run`).

- Lista tudo o que o Docker conhece, agrupado por projeto compose (+ "Avulsos")
- **Subir / Parar / Derrubar / Reiniciar** um projeto inteiro
- **Iniciar / Parar / Reiniciar** um container
- **Terminal** (bash, ou sh se não houver bash) em qualquer container rodando, em abas
- Portas publicadas viram links `localhost:PORTA`

## Uso

```bash
./start.sh            # instala dependências na 1ª vez, sobe e abre o navegador
PANEL_PORT=8000 ./start.sh
```

Acesse <http://127.0.0.1:7777>.

## Requisitos

- Node.js 18+
- Seu usuário com acesso ao Docker (`/var/run/docker.sock`)

## Como funciona

- Containers e terminal: API do Docker via socket (`dockerode`).
- Ações de projeto: `docker compose -p <projeto> -f <arquivos> --project-directory <dir>`,
  usando os caminhos que o próprio Docker grava nos labels dos containers.
- Projetos vistos ficam salvos em `data/projects.json`, então continuam na lista
  depois de um "Derrubar" (e podem ser subidos de novo). O botão ✕ remove da lista.

## Segurança

O painel dá shell em qualquer container, por isso escuta **apenas em 127.0.0.1** e
recusa requisições cujo `Host`/`Origin` não seja o próprio painel.
