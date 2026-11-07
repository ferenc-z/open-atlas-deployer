;; Records redacted fixtures of the nifi-ops graph's monitoring bindings with Studio's connector-api-kit (§9.4 item 3,
;; phase 2 step 6). It reads the contract the Deployer generated, and for each api binding of the services asked for
;; calls the live endpoint through the connector's own path (record!), redacting everything but the mapped fields.
;;
;; Runs with the Studio jar plus the kit's sources (the kit is not in the jar), e.g. in a throwaway container of the
;; Studio image on the host network (the lab nginx listens on 127.0.0.1):
;;   docker run --rm --network host -v <studio>/modules/common/connector-api-kit/src:/kit:ro -v <dir>:/w \
;;     --entrypoint java <studio image> -cp /opt/open-atlas/dist/studio/open-atlas-studio.jar:/kit clojure.main \
;;     /w/record-graph.clj /w/graph.edn /w/sources.edn /w/samples.edn /w/out
;; samples.edn: {"<resolver id>" [{:inputs [{attr value}]}] …}; resolvers with no input need none.
(require '[clojure.edn :as edn]
         '[open.atlas.common.connector.api-kit :as kit])

(let [[graph-file sources-file samples-file out] *command-line-args*
      doc (edn/read-string (slurp graph-file))
      deployed (edn/read-string (slurp sources-file))
      samples (if samples-file (edn/read-string (slurp samples-file)) {})
      {:keys [resolvers bindings selection sources]} (:execution doc)]
  (doseq [[[_ rid] bid] (sort-by (comp second key) selection)
          :let [b (get bindings bid)
                slot (:binding/source b)
                kind (get-in sources [slot :source/kind])
                r (get resolvers rid)]
          :when (and (= "api" kind) (contains? deployed slot) (or (empty? (:input r)) (contains? samples rid)))]
    (let [entry (get deployed slot)
          impl (:binding/implementation b)
          result (kit/record! {:source-id slot :operation-id rid
                               :source-config (merge (dissoc entry :label :health_endpoint :resilience)
                                                     (dissoc impl :result-root) {:type "api"})
                               :resolver-config {:id rid :input (vec (:input r))
                                                 :result_type (if (= :many (:result/cardinality r)) "list" "single")}
                               :samples (get samples rid [{}])
                               :out-dir out})]
      (println rid "->" (:file result) (:exchanges result) "exchange(s)" (if (seq (:failures result)) (pr-str (:failures result)) ""))))
  (let [hits (kit/redaction-check out)]
    (println "redaction-check:" (if (seq hits) (str (count hits) " suspicious value(s)") "clean"))
    (doseq [h hits] (println " " (:file h) (pr-str (:path h)) (:rule h)))))
(shutdown-agents)
(System/exit 0)
