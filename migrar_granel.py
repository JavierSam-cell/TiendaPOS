"""
Migración: agrega soporte para productos a granel / sin código de barras.
Correr UNA VEZ desde la carpeta del proyecto (donde está pos.db):
    python migrar_granel.py

Qué hace:
  - Agrega la columna 'unidad_venta' a productos (default 'pieza').
  - Agrega la columna 'requiere_codigo' a productos (default 1 = True).
No borra ni modifica ningún dato existente.
"""
import sqlite3

conn = sqlite3.connect("pos.db")
cur = conn.cursor()

cur.execute("PRAGMA table_info(productos)")
columnas = [fila[1] for fila in cur.fetchall()]

cambios = []

if "unidad_venta" not in columnas:
    cur.execute("ALTER TABLE productos ADD COLUMN unidad_venta TEXT DEFAULT 'pieza'")
    cambios.append("unidad_venta")

if "requiere_codigo" not in columnas:
    cur.execute("ALTER TABLE productos ADD COLUMN requiere_codigo BOOLEAN DEFAULT 1")
    cambios.append("requiere_codigo")

conn.commit()
conn.close()

if cambios:
    print(f"Migración completa. Columnas agregadas: {', '.join(cambios)}")
else:
    print("Ya estaba migrado, no se hizo ningún cambio.")
