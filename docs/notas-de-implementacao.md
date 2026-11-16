# Notas de implementação

O código deste repositório não tem comentários. O que não dá para deduzir lendo o código — o porquê de uma escolha, restrições externas, contratos com os outros repositórios — fica aqui, organizado por arquivo. As decisões de arquitetura da Fase 4 estão nas ADRs do [OS Service](https://github.com/Xikin/tech_challenge/blob/main/docs/adr/README.md).

---

## Domínio

### `src/domain/orcamento/orcamento.ts`

- `estornar` vale a partir de `PAGO` (compensação) e de `CANCELADO` (pagamento que chegou depois do cancelamento).
- `calcularTotal` e `valorConfere` trabalham em centavos inteiros; comparar `284.99999` com `285` em ponto flutuante recusaria pagamentos corretos.
- `desfechoDoMercadoPago` agrupa os status da API: `approved` aprova; `rejected` e `cancelled` recusam; `refunded` e `charged_back` são estornos; o resto (`pending`, `in_process`, `authorized`) é ignorado até a próxima notificação.

## Aplicação

### `src/application/mensageria/processar-comando.use-case.ts`

- Não há tabela de mensagens processadas: a idempotência vem do próprio dado. Orçamento repetido esbarra no índice único de `ordemId`; cancelamento repetido encontra o orçamento já encerrado e só reconfirma. A saga ignora a confirmação duplicada.
- Diagnóstico sem itens grava o orçamento já `CANCELADO` e responde `orcamento-falhou`. Sem o documento, o comando de cancelamento que vem em seguida criaria um registro sem cliente.
- **Estorno antes de gravar.** Na compensação de orçamento pago, o estorno no Mercado Pago acontece antes de mudar o documento. Se a gravação falhar (conflito, Mongo fora), a mensagem é reprocessada e o estorno é repetido com a mesma `X-Idempotency-Key` (`estorno-<orcamento>`), que o Mercado Pago trata como a mesma operação.
- Cancelamento que chega antes do orçamento cria um registro `CANCELADO`. Se nesse meio-tempo o orçamento for criado por outra réplica, `CancelamentoAntesDoOrcamentoError` faz a mensagem voltar pela retentativa e, na próxima vez, encontrar o orçamento.

### `src/application/use-cases/pagamentos.use-cases.ts`

- O resultado do pagamento sempre vem do `PagamentoNoGateway` consultado na API, nunca do corpo do webhook.
- **Todo pagamento aprovado que não quita o orçamento é estornado:** chegou depois do cancelamento ou da reprovação, é um segundo pagamento de orçamento já pago, ou tem valor menor que o total. A regra é "o id do pagamento não é o que quitou este orçamento". O primeiro teste com o broker real mostrou que, sem ela, um segundo pagamento num orçamento já estornado era ignorado e o dinheiro ficava retido.
- Notificação repetida do pagamento que já quitou o orçamento é ignorada (o Mercado Pago reenvia notificações).

### `src/application/use-cases/orcamentos.use-cases.ts`

A cobrança no Mercado Pago é criada **antes** de mudar o orçamento para `APROVADO`. Se o Mercado Pago falhar, o cliente recebe 502 e o orçamento continua aguardando aprovação; ele pode tentar de novo. A preferência vai com `X-Idempotency-Key` igual a `cobranca-<orcamento>`. Mesmo que uma nova tentativa gere outra preferência, preferência não cobra nada: só o link que o cliente pagar vira pagamento, e um segundo pagamento é estornado automaticamente.

## Infraestrutura

### `src/infrastructure/database/mongo.ts` e `mongo-orcamentos.repository.ts`

- Um documento por orçamento, com `_id` igual ao id do orçamento: itens, pagamento, histórico e as mensagens pendentes (`saidas`). Mudar o status e enfileirar o evento é um único `findOneAndUpdate`, atômico no MongoDB sem transação multi-documento e sem replica set.
- O filtro da mudança inclui `status` e `versao`; documento não encontrado significa que outro processo mudou o orçamento (`OrcamentoAlteradoError`).
- Índices: `ordemId` único (idempotência da criação), `status + criadoEm` (listagem), `cliente.id` (consultas do cliente) e `saidas.id` esparso (o relay só olha documentos com saída pendente; quando o array esvazia, o documento sai do índice).
- `paraOrcamento` remove `saidas` e `bloqueadoAte` do que a API devolve: são detalhes do outbox.

### `src/infrastructure/mensageria/outbox-relay-mongo.ts`

- Reserva o documento com `bloqueadoAte` (30 s) via `findOneAndUpdate` antes de publicar, para que duas réplicas não publiquem as mesmas saídas. Se o processo morrer, o bloqueio expira e outra réplica assume. Nesse caso uma mensagem pode sair duas vezes, e o consumidor deduplica.
- Remove cada saída com `$pull` logo depois de publicada, não no fim do lote: uma queda no meio não republica o que já saiu.

### `src/infrastructure/pagamentos/mercado-pago.gateway.ts`

- `fetch` nativo em vez do SDK do Mercado Pago: são três chamadas, e o SDK traria dependências e tipos que mudam a cada versão.
- Token `TEST-...` usa `sandbox_init_point`; o link de produção não aceita usuários de teste.
- Timeout de 10 s por chamada (`AbortSignal.timeout`); qualquer falha vira `GatewayIndisponivelError` (502 na API, retentativa na fila).
- `GatewaySimulado.consultarPagamento` falha de propósito: no modo simulado, um webhook "real" não deveria chegar, e aceitá-lo daria a impressão de integração que não existe.

### `src/infrastructure/pagamentos/assinatura-webhook.ts`

Manifesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` com HMAC-SHA256 e comparação em tempo constante, como na documentação do Mercado Pago (id alfanumérico em minúsculas). Não há janela de tempo por padrão: o Mercado Pago reenvia notificações antigas, e como o status é sempre consultado na API, reenviar uma notificação válida não causa dano. A tolerância existe como opção (`toleranciaSegundos`).

### `src/presentation/http/routes/pagamentos.routes.ts`

O simulador responde 404 no modo real, em vez de 403, para não anunciar que a rota existe.

## Configuração

### `k8s/mongodb.yaml`

Uma réplica, volume EBS de 2 GiB, usuário root criado pelo `MONGO_INITDB_*` com senha gerada pelo pipeline no SSM. É suficiente para o ambiente de avaliação; em produção o caminho é o Atlas (basta o secret `MONGODB_URI`) ou um replica set de três membros. A `NetworkPolicy` só aceita conexões dos pods `app=oficina-billing`.

### `.github/workflows/ci-cd.yml`

- `MERCADO_PAGO_MODO` vira `real` sozinho quando o secret `MERCADO_PAGO_ACCESS_TOKEN` existe; sem ele, o serviço sobe simulado em vez de falhar.
- `BILLING_URL_PUBLICA` vem de `/oficina/<env>/gateway/url`, publicado pelo Terraform da Lambda. Na primeira implantação, antes da Lambda, o webhook ainda não tem endereço público; refazer o deploy do Billing depois corrige.

### `Dockerfile`

Sem Prisma, a imagem pode remover as dependências de desenvolvimento (`npm prune --omit=dev`), ao contrário do OS Service e do Execução, que precisam da CLI do Prisma para rodar as migrations na subida.
